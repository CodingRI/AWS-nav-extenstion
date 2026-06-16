import axios from "axios";
import type {
  NextStepRequest,
  NextStepResponse,
  GuidanceStep,
} from "@aws-nav/shared";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is missing");
}

export class AIService {
  async generateNextStep(request: NextStepRequest): Promise<NextStepResponse> {
    const prompt = this.buildContextAwarePrompt(request);

    try {
      console.log("[AIService] Requesting next step from OpenRouter...");
      console.log("[AIService] Goal:", request.goal);
      console.log("[AIService] Service:", request.pageContext.service);
      console.log(
        "[AIService] Visible elements:",
        request.pageContext.visibleButtons.length,
      );
      console.log("[AIService] History steps:", request.history.length);

      const response = await axios.post(
        OPENROUTER_API_URL,
        {
          model: "openai/gpt-4o",
          messages: [
            {
              role: "system",
              content: this.getSystemPrompt(),
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
          max_tokens: 1500,
          response_format: {
            type: "json_object",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer":
              process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
            "X-Title": process.env.OPENROUTER_SITE_NAME ?? "AWS Navigator",
          },
        },
      );

      const responseText = response.data.choices?.[0]?.message?.content ?? "";

      console.log("[AIService] Raw response:", responseText);

      return this.parseStructuredResponse(responseText, request);
    } catch (error: any) {
      console.error(
        "[AIService] OpenRouter Error:",
        error?.response?.data || error.message,
      );

      return {
        success: false,
        steps: [this.getFallbackStep(request)],
        isComplete: false,
        error: "Failed to generate next step. Please try again.",
      };
    }
  }

  private getSystemPrompt(): string {
    return `
You are an AWS Console navigation expert.

Your job is to guide a user through AWS by analyzing the current page.

You receive:

1. User goal
2. Current page information
3. Visible interactive elements
4. Previously completed steps

Return a JSON object with a "steps" array. Each step is one action on the CURRENT page.

For FORM pages (with multiple input fields), return ALL fields and the submit button as separate steps in order.
For NAVIGATION pages (just need to click a link/button), return a single step.

Example — form page:

{
  "steps": [
    {
      "instruction": "Enter a name for your bucket",
      "targetText": "[input: Bucket name]",
      "targetSelector": "[input: Bucket name]",
      "fallbackText": "Text input field labeled Bucket name",
      "waitFor": "field filled"
    },
    {
      "instruction": "Click the Create bucket button",
      "targetText": "Create bucket",
      "targetSelector": "Create bucket",
      "fallbackText": "Orange Create bucket button at the bottom",
      "waitFor": "Bucket list page"
    }
  ],
  "isComplete": false,
  "message": "Fill in the form to create a bucket"
}

Example — navigation page:

{
  "steps": [
    {
      "instruction": "Click the Instances link",
      "targetText": "Instances",
      "targetSelector": "Instances",
      "fallbackText": "Instances link in the left sidebar",
      "waitFor": "Instances list page"
    }
  ],
  "isComplete": false,
  "message": "Navigate to the Instances page"
}

RULES:

1. ONLY select elements from the provided element list.
2. NEVER invent element names.
3. targetText MUST exactly match an element's "text" value from the list. Copy it exactly.
4. For input fields, copy the EXACT text value (e.g. "[input: Name]"). Do NOT use placeholder values.
5. Keep targetText SHORT. If an element's text is very long, use only the first meaningful part (e.g. "Amazon Linux 2023" not the full AMI description).
6. Order steps logically: fill inputs first, then click submit/next.
7. Avoid repeating completed steps.
8. If a loop is detected, choose a different path.
9. If the current page already contains the needed form or action, use it.
10. If the user's goal has been completed, set isComplete=true.
11. fallbackText should visually describe where the target element is located.
12. NEVER return markdown.
13. ALWAYS return valid JSON with a "steps" array.
14. Keep each step's targetText under 60 characters.
`;
  }

  private buildContextAwarePrompt(request: NextStepRequest): string {
    const { goal, pageContext, history } = request;

    const formatEl = (
      el: (typeof pageContext.visibleButtons)[0],
      i: number,
    ) => {
      const parts = [`${i + 1}. [${el.tagName}]`];

      if (el.text) {
        parts.push(`text="${el.text}"`);
      }

      if (el.ariaLabel && el.ariaLabel !== el.text) {
        parts.push(`aria-label="${el.ariaLabel}"`);
      }

      if (el.role) {
        parts.push(`role="${el.role}"`);
      }

      if (el.inputType) {
        parts.push(`type="${el.inputType}"`);
      }

      if (el.placeholder) {
        parts.push(`placeholder="${el.placeholder}"`);
      }

      if (el.name) {
        parts.push(`name="${el.name}"`);
      }

      if (el.value) {
        parts.push(`value="${el.value}"`);
      }

      return parts.join(" ");
    };

    const elementsList = pageContext.visibleButtons
      .map((el, i) => formatEl(el, i))
      .join("\n");

    const historyText =
      history.length === 0
        ? "None"
        : history.map((h, i) => `${i + 1}. ${h.instruction} ✓`).join("\n");

    const recentSteps = history
      .slice(-6)
      .map((h) => h.targetText || h.instruction);

    const uniqueSteps = new Set(recentSteps);

    const loopDetected = recentSteps.length >= 4 && uniqueSteps.size <= 2;

    const formStateText =
      Object.keys(pageContext.formState).length > 0
        ? Object.entries(pageContext.formState)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")
        : "No active forms or dialogs.";

    return `
USER GOAL:
${goal}

CURRENT PAGE:
- URL: ${pageContext.url}
- Service: ${pageContext.service}
- View: ${pageContext.view}
- Breadcrumbs:
${
  pageContext.breadcrumb.length > 0
    ? pageContext.breadcrumb.join(" > ")
    : "None"
}

PAGE STATE:
${formStateText}

VISIBLE ELEMENTS (${pageContext.visibleButtons.length}):

${elementsList || "No elements found"}

COMPLETED STEPS:

${historyText}

${
  loopDetected
    ? `
WARNING:
Navigation loop detected.

DO NOT repeat recent steps.
DO NOT return to pages already visited.
Choose a different path.
`
    : ""
}

Think carefully.

First determine whether the user is already on the correct page.

Then determine all actions needed on THIS page before navigation.

Respond with JSON only (with a "steps" array).
`;
  }

  private parseStructuredResponse(
    responseText: string,
    request: NextStepRequest,
  ): NextStepResponse {
    try {
      let clean = responseText.trim();

      if (clean.startsWith("```")) {
        clean = clean.replace(/```json?\s*/g, "").replace(/```\s*$/g, "");
      }

      const parsed = JSON.parse(clean);

      const rawSteps: any[] = Array.isArray(parsed.steps)
        ? parsed.steps
        : parsed.instruction
          ? [parsed]
          : [];

      if (rawSteps.length === 0) {
        throw new Error("No steps in response");
      }

      const steps: GuidanceStep[] = rawSteps.map((s, i) => ({
        instruction: (s.instruction || "").trim(),
        targetSelector: (s.targetSelector || s.targetText || "").trim(),
        targetText: (s.targetText || s.targetSelector || "").trim(),
        fallbackText: (s.fallbackText || "").trim(),
        waitFor: (s.waitFor || "").trim(),
        stepIndex: request.history.length + i,
      }));

      return {
        success: true,
        steps,
        isComplete: parsed.isComplete === true,
        message: parsed.message || undefined,
      };
    } catch (err) {
      console.error("[AIService] Failed to parse response:", err);
      console.error("[AIService] Raw text:", responseText);

      const instruction = this.extractInstructionFromText(responseText);

      if (instruction) {
        return {
          success: true,
          steps: [
            {
              instruction,
              targetSelector: "",
              targetText: "",
              fallbackText: "",
              waitFor: "",
              stepIndex: request.history.length,
            },
          ],
          isComplete: false,
          message: "AI returned non-JSON response.",
        };
      }

      return {
        success: false,
        steps: [this.getFallbackStep(request)],
        isComplete: false,
        error: "Could not parse AI response.",
      };
    }
  }

  private extractInstructionFromText(text: string): string | null {
    const clean = text.trim();

    if (clean.length > 10 && clean.length < 200) {
      return clean;
    }

    const match = clean.match(
      /(Click|Type|Select|Navigate|Open|Enter|Choose|Search|Scroll|Find).+?[.!]/i,
    );

    return match ? match[0] : null;
  }

  private getFallbackStep(request: NextStepRequest): GuidanceStep {
    return {
      instruction: `Look for the next action related to: "${request.goal}"`,
      targetSelector: "",
      targetText: "",
      fallbackText: "",
      waitFor: "",
      stepIndex: request.history.length,
    };
  }
}

export const aiService = new AIService();
