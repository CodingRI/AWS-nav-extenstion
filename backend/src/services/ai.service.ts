import axios from 'axios';
import type { NavigationStep } from '@aws-nav/shared';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is missing');
}

interface NextStepRequest {
  goal: string;
  history: Array<{
    stepNumber: number;
    instruction: string;
    pageUrl: string;
    completed: boolean;
  }>;
  currentPage: {
    url: string;
    title: string;
    service: string;
    breadcrumbs: string[];
  };
  availableActions: Array<{
    type: string;
    text: string;
    selector: string;
  }>;
}

export class AIService {
  /**
   * Generate next single step based on current page context (NEW DYNAMIC APPROACH)
   */
  async generateNextStep(request: NextStepRequest): Promise<{ instruction: string }> {
    const prompt = this.buildNextStepPrompt(request);

    try {
      console.log('[AIService] Requesting next step from OpenRouter...');

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'openai/gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'You are an AWS Console navigation expert. Provide clear, single-step instructions.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.3,
          max_tokens: 200,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
            'X-Title': process.env.OPENROUTER_SITE_NAME || 'AWS Navigator',
          },
        }
      );

      const responseText = response.data.choices[0]?.message?.content || '';
      console.log('[AIService] Next step received:', responseText);

      const instruction = this.parseInstruction(responseText);
      return { instruction };

    } catch (error: any) {
      console.error('[AIService] OpenRouter Error:', error?.response?.data || error.message);
      throw new Error('Failed to generate next step');
    }
  }

  /**
   * Build prompt for next step generation
   */
  private buildNextStepPrompt(request: NextStepRequest): string {
    const { goal, history, currentPage, availableActions } = request;

    return `You are an AWS Console navigation assistant. Guide the user step-by-step to accomplish their goal.

**User's Goal:** ${goal}

**Current Page Context:**
- URL: ${currentPage.url}
- Title: ${currentPage.title}
- Service: ${currentPage.service}
- Breadcrumbs: ${currentPage.breadcrumbs.join(' > ')}

**Steps Completed So Far:**
${history.length === 0 ? 'None (this is the first step)' : history.map(h => `${h.stepNumber}. ${h.instruction} ✓`).join('\n')}

**Available Interactive Elements on Current Page:**
${availableActions.slice(0, 25).map((a, i) => `${i + 1}. [${a.type}] "${a.text}"`).join('\n')}

---

**Your Task:**
Provide the NEXT SINGLE STEP the user should take.

**Rules:**
1. Give ONE clear, actionable instruction
2. Use exact element text from available elements
3. Be specific (e.g., "Click the 'Create user' button")
4. If goal is complete, respond: "GOAL_COMPLETE: [what was accomplished]"
5. Keep it concise

**Examples:**
- "Click the 'IAM' link"
- "Click the 'Create user' button"
- "Enter 'my-test-user' in the User name field"
- "GOAL_COMPLETE: IAM user created successfully"

Your instruction (plain text only, no quotes or formatting):`;
  }

  /**
   * Parse and clean instruction from AI response
   */
  private parseInstruction(text: string): string {
    let instruction = text.trim();

    // Remove common prefixes
    instruction = instruction.replace(/^(Step \d+:|Next step:|Instruction:)\s*/i, '');
    
    // Remove quotes if wrapped
    instruction = instruction.replace(/^["'](.+)["']$/s, '$1');
    
    // Remove markdown
    instruction = instruction.replace(/`/g, '');

    return instruction;
  }

  /**
   * Legacy method - Generate all steps at once (KEPT FOR BACKWARD COMPATIBILITY)
   */
  async generateNavigationSteps(query: string): Promise<{
    steps: NavigationStep[];
    summary: string;
  }> {
    const prompt = this.buildLegacyPrompt(query);

    try {
      console.log('[AIService] Sending request to OpenRouter (legacy mode)...');

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'openai/gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'You are an expert AWS console navigation assistant. Always return valid JSON.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
            'X-Title': process.env.OPENROUTER_SITE_NAME || 'AWS Navigator',
          },
        }
      );

      const responseText = response.data.choices[0]?.message?.content || '';
      console.log('[AIService] OpenRouter response received');

      return this.parseResponse(responseText);

    } catch (error: any) {
      console.error('[AIService] OpenRouter Error:', error?.response?.data || error.message);
      throw new Error('Failed to generate navigation steps');
    }
  }

  /**
   * Build legacy prompt (all steps at once)
   */
  private buildLegacyPrompt(query: string): string {
    return `
User wants to: "${query}"

Provide AWS Console navigation steps.

Return ONLY JSON:

{
  "summary": "Short summary",
  "steps": [
    {
      "stepNumber": 1,
      "instruction": "",
      "selector": "",
      "alternativeSelectors": [],
      "textContent": "",
      "page": "",
      "waitForNavigation": false,
      "scrollIntoView": true
    }
  ]
}

Rules:
- No markdown
- No explanation
- JSON only
- 5-8 steps
`;
  }

  /**
   * Parse legacy AI response
   */
  private parseResponse(response: string): {
    steps: NavigationStep[];
    summary: string;
  } {
    try {
      let clean = response.trim();

      if (clean.includes('```')) {
        clean = clean.replace(/```[\s\S]*?```/g, '');
      }

      const match = clean.match(/\{[\s\S]*\}/);
      if (match) clean = match[0];

      const parsed = JSON.parse(clean);

      if (!Array.isArray(parsed.steps)) {
        throw new Error('Invalid format');
      }

      const validSteps = parsed.steps.filter((s: any) => this.validateStep(s));

      return {
        steps: validSteps,
        summary: parsed.summary || 'Here are the steps to complete your task.',
      };

    } catch (err) {
      console.error('[AIService] Parse error:', err);

      return {
        steps: this.getFallbackSteps(),
        summary: 'AI response could not be parsed.',
      };
    }
  }

  /**
   * Validate step
   */
  private validateStep(step: any): step is NavigationStep {
    return (
      typeof step.stepNumber === 'number' &&
      typeof step.instruction === 'string' &&
      typeof step.selector === 'string' &&
      typeof step.page === 'string'
    );
  }

  /**
   * Fallback steps
   */
  private getFallbackSteps(): NavigationStep[] {
    return [
      {
        stepNumber: 1,
        instruction: 'AI failed to generate proper steps. Try again.',
        selector: 'body',
        alternativeSelectors: [],
        textContent: '',
        page: '/',
        waitForNavigation: false,
        scrollIntoView: false,
      },
    ];
  }
}

export const aiService = new AIService();