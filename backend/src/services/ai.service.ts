import axios from "axios";
import type {
  NextStepRequest,
  NextStepResponse,
  GuidanceStep,
} from "@aws-nav/shared";

const OPENROUTER_API_URL =
  "https://openrouter.ai/api/v1/chat/completions";

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is missing");
}

export class AIService {
  async generateNextStep(
    request: NextStepRequest,
  ): Promise<NextStepResponse> {
    const prompt = this.buildContextAwarePrompt(request);

    try {
      console.log(
        "[AIService] Requesting next step from OpenRouter...",
      );
      console.log("[AIService] Goal:", request.goal);
      console.log(
        "[AIService] Service:",
        request.pageContext.service,
      );
      console.log(
        "[AIService] Visible elements:",
        request.pageContext.visibleButtons.length,
      );
      console.log(
        "[AIService] History steps:",
        request.history.length,
      );

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
          max_tokens: 500,
          response_format: {
            type: "json_object",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer":
              process.env.OPENROUTER_SITE_URL ??
              "http://localhost:3000",
            "X-Title":
              process.env.OPENROUTER_SITE_NAME ??
              "AWS Navigator",
          },
        },
      );

      const responseText =
        response.data.choices?.[0]?.message?.content ?? "";

      console.log(
        "[AIService] Raw response:",
        responseText,
      );

      return this.parseStructuredResponse(
        responseText,
        request,
      );
    } catch (error: any) {
      console.error(
        "[AIService] OpenRouter Error:",
        error?.response?.data || error.message,
      );

      return {
        success: false,
        step: this.getFallbackStep(request),
        isComplete: false,
        error:
          "Failed to generate next step. Please try again.",
      };
    }
  }

  private getSystemPrompt(): string {
    return `
You are an AWS Console navigation expert.

Your job is to guide a user through AWS one step at a time.

You receive:

1. User goal
2. Current page information
3. Visible interactive elements
4. Previously completed steps

Return EXACTLY ONE JSON object.

Example:

{
  "instruction": "Click the Create bucket button",
  "targetText": "Create bucket",
  "targetSelector": "Create bucket",
  "fallbackText": "Blue Create bucket button near the bottom of the form",
  "waitFor": "Bucket list page",
  "isComplete": false,
  "message": "Optional explanation"
}

RULES:

1. ONLY select elements from the provided element list.
2. NEVER invent element names.
3. targetText must exactly match an element in the list.
4. Give ONE action only.
5. Avoid repeating completed steps.
6. If a loop is detected, choose a different path.
7. If the current page already contains the needed form or action, use it instead of navigating elsewhere.
8. If the user's goal has been completed, set isComplete=true.
9. fallbackText should visually describe where the target element is located.
10. NEVER return markdown.
11. ALWAYS return valid JSON.
`;
  }

  private buildContextAwarePrompt(
    request: NextStepRequest,
  ): string {
    const {
      goal,
      pageContext,
      history,
    } = request;

    const formatEl = (
      el: (typeof pageContext.visibleButtons)[0],
      i: number,
    ) => {
      const parts = [`${i + 1}. [${el.tagName}]`];

      if (el.text) {
        parts.push(`text="${el.text}"`);
      }

      if (
        el.ariaLabel &&
        el.ariaLabel !== el.text
      ) {
        parts.push(
          `aria-label="${el.ariaLabel}"`,
        );
      }

      if (el.role) {
        parts.push(`role="${el.role}"`);
      }

      return parts.join(" ");
    };

    const elementsList =
      pageContext.visibleButtons
        .map((el, i) => formatEl(el, i))
        .join("\n");

    const historyText =
      history.length === 0
        ? "None"
        : history
            .map(
              (h, i) =>
                `${i + 1}. ${h.instruction} ✓`,
            )
            .join("\n");

    const recentSteps = history
      .slice(-6)
      .map(
        (h) =>
          h.targetText ||
          h.instruction,
      );

    const uniqueSteps =
      new Set(recentSteps);

    const loopDetected =
      recentSteps.length >= 4 &&
      uniqueSteps.size <= 2;

    const formStateText =
      Object.keys(pageContext.formState)
        .length > 0
        ? Object.entries(
            pageContext.formState,
          )
            .map(
              ([k, v]) =>
                `- ${k}: ${v}`,
            )
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

Then choose the single best next action.

Respond with JSON only.
`;
  }

  private parseStructuredResponse(
    responseText: string,
    request: NextStepRequest,
  ): NextStepResponse {
    try {
      let clean =
        responseText.trim();

      if (
        clean.startsWith("```")
      ) {
        clean = clean
          .replace(
            /```json?\s*/g,
            "",
          )
          .replace(
            /```\s*$/g,
            "",
          );
      }

      const parsed =
        JSON.parse(clean);

      if (
        !parsed.instruction ||
        typeof parsed.instruction !==
          "string"
      ) {
        throw new Error(
          "Missing instruction",
        );
      }

      const step: GuidanceStep =
        {
          instruction:
            parsed.instruction.trim(),

          targetSelector: (
            parsed.targetSelector ||
            parsed.targetText ||
            ""
          ).trim(),

          targetText: (
            parsed.targetText ||
            parsed.targetSelector ||
            ""
          ).trim(),

          fallbackText: (
            parsed.fallbackText ||
            ""
          ).trim(),

          waitFor: (
            parsed.waitFor ||
            ""
          ).trim(),

          stepIndex:
            request.history.length,
        };

      return {
        success: true,
        step,
        isComplete:
          parsed.isComplete ===
          true,
        message:
          parsed.message ||
          undefined,
      };
    } catch (err) {
      console.error(
        "[AIService] Failed to parse response:",
        err,
      );

      console.error(
        "[AIService] Raw text:",
        responseText,
      );

      const instruction =
        this.extractInstructionFromText(
          responseText,
        );

      if (instruction) {
        return {
          success: true,
          step: {
            instruction,
            targetSelector: "",
            targetText: "",
            fallbackText: "",
            waitFor: "",
            stepIndex:
              request.history.length,
          },
          isComplete: false,
          message:
            "AI returned non-JSON response.",
        };
      }

      return {
        success: false,
        step: this.getFallbackStep(
          request,
        ),
        isComplete: false,
        error:
          "Could not parse AI response.",
      };
    }
  }

  private extractInstructionFromText(
    text: string,
  ): string | null {
    const clean =
      text.trim();

    if (
      clean.length > 10 &&
      clean.length < 200
    ) {
      return clean;
    }

    const match =
      clean.match(
        /(Click|Type|Select|Navigate|Open|Enter|Choose|Search|Scroll|Find).+?[.!]/i,
      );

    return match
      ? match[0]
      : null;
  }

  private getFallbackStep(
    request: NextStepRequest,
  ): GuidanceStep {
    return {
      instruction: `Look for the next action related to: "${request.goal}"`,
      targetSelector: "",
      targetText: "",
      fallbackText: "",
      waitFor: "",
      stepIndex:
        request.history.length,
    };
  }
}

export const aiService =
  new AIService();