import axios from 'axios';
import type { NextStepRequest, NextStepResponse, GuidanceStep } from '@aws-nav/shared';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY is missing');
}

export class AIService {
  /**
   * Generate the next single step based on full page context.
   * This is the core of Phase 2 — the LLM gets the real DOM state
   * and returns exactly ONE structured action.
   */
  async generateNextStep(request: NextStepRequest): Promise<NextStepResponse> {
    const prompt = this.buildContextAwarePrompt(request);

    try {
      console.log('[AIService] Requesting next step from OpenRouter...');
      console.log('[AIService] Goal:', request.goal);
      console.log('[AIService] Service:', request.pageContext.service);
      console.log('[AIService] Visible elements:', request.pageContext.visibleButtons.length);
      console.log('[AIService] History steps:', request.history.length);

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: 'openai/gpt-4o',
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt(),
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 500,
          response_format: { type: 'json_object' },
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
      console.log('[AIService] Raw response:', responseText);

      return this.parseStructuredResponse(responseText, request);

    } catch (error: any) {
      console.error('[AIService] OpenRouter Error:', error?.response?.data || error.message);
      
      return {
        success: false,
        step: this.getFallbackStep(request),
        isComplete: false,
        error: 'Failed to generate next step. Please try again.',
      };
    }
  }

  /**
   * System prompt — defines the AI's role and output format.
   */
  private getSystemPrompt(): string {
    return `You are an AWS Console navigation expert embedded in a browser extension. 
Your job is to guide users step-by-step through AWS Console tasks.

You will receive:
1. The user's goal
2. The current page context (URL, service, visible interactive elements, breadcrumbs)
3. History of steps already completed

You must respond with EXACTLY ONE next action in this JSON format:
{
  "instruction": "Human-readable instruction (e.g., Click the 'Create bucket' button)",
  "targetText": "Exact visible text of the element to interact with (e.g., Create bucket)",
  "targetSelector": "Best selector: aria-label value, or CSS selector (e.g., Create bucket)",
  "waitFor": "What should appear after this action (e.g., Bucket creation form)",
  "isComplete": false,
  "message": "Optional additional context"
}

CRITICAL RULES:
1. ALWAYS pick targetText from the ACTUAL visible elements listed in the context. Do NOT invent element names.
2. targetText should be the exact text as shown in the visible elements list.
3. targetSelector should be the aria-label of the element if available, otherwise the text content.
4. Give only ONE action at a time — the user will come back with new context after completing it.
5. If the goal is already accomplished on the current page, set isComplete to true.
6. Keep instructions clear and specific. Reference the exact button/link text.
7. If the required element is not in the visible elements list, describe what the user should look for.
8. For text inputs, use instruction like "Type 'value' in the 'Field name' input field".
9. ALWAYS respond with valid JSON. No markdown, no explanation outside the JSON.`;
  }

  /**
   * Build the context-aware prompt with full page state.
   */
  private buildContextAwarePrompt(request: NextStepRequest): string {
    const { goal, pageContext, history } = request;

    // Format visible elements list
    const elementsList = pageContext.visibleButtons
      .slice(0, 40) // Cap to prevent token overflow
      .map((el, i) => {
        const parts = [`${i + 1}. [${el.tagName}]`];
        if (el.text) parts.push(`text="${el.text}"`);
        if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
        if (el.role) parts.push(`role="${el.role}"`);
        return parts.join(' ');
      })
      .join('\n');

    // Format history
    const historyText = history.length === 0
      ? 'None — this is the first step.'
      : history.map((h, i) => `${i + 1}. ${h.instruction} ✓`).join('\n');

    // Format form state
    const formStateText = Object.keys(pageContext.formState).length > 0
      ? Object.entries(pageContext.formState)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join('\n')
      : 'No active forms or dialogs.';

    return `
**USER'S GOAL:** ${goal}

**CURRENT PAGE:**
- URL: ${pageContext.url}
- Service: ${pageContext.service}
- View: ${pageContext.view}
- Page Title: ${pageContext.title}
- Breadcrumbs: ${pageContext.breadcrumb.length > 0 ? pageContext.breadcrumb.join(' > ') : 'None'}

**PAGE STATE:**
${formStateText}

**VISIBLE INTERACTIVE ELEMENTS ON THIS PAGE:**
${elementsList || 'No interactive elements found.'}

**STEPS ALREADY COMPLETED:**
${historyText}

**YOUR TASK:**
Based on the current page state and visible elements, provide the NEXT SINGLE ACTION to accomplish the user's goal.
Remember: pick targetText from the actual visible elements listed above.
Respond with JSON only.`;
  }

  /**
   * Parse the structured JSON response from the LLM.
   */
  private parseStructuredResponse(
    responseText: string,
    request: NextStepRequest
  ): NextStepResponse {
    try {
      // Clean up response
      let clean = responseText.trim();

      // Remove markdown code blocks if present
      if (clean.startsWith('```')) {
        clean = clean.replace(/```json?\s*/g, '').replace(/```\s*$/g, '');
      }

      const parsed = JSON.parse(clean);

      // Validate required fields
      if (!parsed.instruction || typeof parsed.instruction !== 'string') {
        throw new Error('Missing or invalid instruction field');
      }

      const step: GuidanceStep = {
        instruction: parsed.instruction.trim(),
        targetSelector: (parsed.targetSelector || parsed.targetText || '').trim(),
        targetText: (parsed.targetText || parsed.targetSelector || '').trim(),
        waitFor: (parsed.waitFor || '').trim(),
        stepIndex: request.history.length,
      };

      return {
        success: true,
        step,
        isComplete: parsed.isComplete === true,
        message: parsed.message || undefined,
      };

    } catch (err) {
      console.error('[AIService] Failed to parse response:', err);
      console.error('[AIService] Raw text was:', responseText);

      // Try to extract instruction from free text as fallback
      const instruction = this.extractInstructionFromText(responseText);
      if (instruction) {
        return {
          success: true,
          step: {
            instruction,
            targetSelector: '',
            targetText: '',
            waitFor: '',
            stepIndex: request.history.length,
          },
          isComplete: false,
          message: 'Note: AI response was not properly structured.',
        };
      }

      return {
        success: false,
        step: this.getFallbackStep(request),
        isComplete: false,
        error: 'Could not parse AI response.',
      };
    }
  }

  /**
   * Try to extract a useful instruction from free text (when JSON parsing fails).
   */
  private extractInstructionFromText(text: string): string | null {
    const clean = text.trim();
    if (clean.length > 10 && clean.length < 200) {
      return clean;
    }
    // Try to find a sentence that starts with an action word
    const match = clean.match(/(Click|Type|Select|Navigate|Open|Enter|Choose|Search|Scroll|Look for|Find).+?[.!]/i);
    return match ? match[0] : null;
  }

  /**
   * Generate a fallback step when AI fails.
   */
  private getFallbackStep(request: NextStepRequest): GuidanceStep {
    return {
      instruction: `Look for the next action related to: "${request.goal}"`,
      targetSelector: '',
      targetText: '',
      waitFor: '',
      stepIndex: request.history.length,
    };
  }
}

export const aiService = new AIService();