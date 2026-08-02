import type {
  GuidanceStep,
  NextStepRequest,
  NextStepResponse,
  OpenRouterChatCompletionResponse,
} from "@aws-nav/shared";

export function buildNavigationSystemPrompt(): string {
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
5. Keep targetText SHORT. If an element's text is very long, use only the first meaningful part.
6. Order steps logically: fill inputs first, then click submit or next.
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

export function buildNavigationPrompt(request: NextStepRequest): string {
  const { goal, pageContext, history } = request;

  const elementsList = pageContext.visibleButtons
    .map((element, index) => {
      const parts = [`${index + 1}. [${element.tagName}]`];

      if (element.text) {
        parts.push(`text="${element.text}"`);
      }
      if (element.ariaLabel && element.ariaLabel !== element.text) {
        parts.push(`aria-label="${element.ariaLabel}"`);
      }
      if (element.role) {
        parts.push(`role="${element.role}"`);
      }
      if (element.inputType) {
        parts.push(`type="${element.inputType}"`);
      }
      if (element.placeholder) {
        parts.push(`placeholder="${element.placeholder}"`);
      }
      if (element.name) {
        parts.push(`name="${element.name}"`);
      }
      if (element.value) {
        parts.push(`value="${element.value}"`);
      }

      return parts.join(" ");
    })
    .join("\n");

  const historyText =
    history.length === 0
      ? "None"
      : history.map((step, index) => `${index + 1}. ${step.instruction} ✓`).join("\n");

  const recentSteps = history.slice(-6).map((step) => step.targetText || step.instruction);
  const loopDetected =
    recentSteps.length >= 4 && new Set(recentSteps).size <= 2;

  const formStateText =
    Object.keys(pageContext.formState).length > 0
      ? Object.entries(pageContext.formState)
          .map(([label, value]) => `- ${label}: ${value}`)
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
${pageContext.breadcrumb.length > 0 ? pageContext.breadcrumb.join(" > ") : "None"}

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

export function extractResponseText(
  response: OpenRouterChatCompletionResponse,
): string {
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}

export function parseNextStepResponse(
  responseText: string,
  request: NextStepRequest,
): NextStepResponse {
  try {
    let cleanText = responseText.trim();

    if (cleanText.startsWith("```")) {
      cleanText = cleanText
        .replace(/```json?\s*/g, "")
        .replace(/```\s*$/g, "");
    }

    const parsed = JSON.parse(cleanText) as {
      steps?: Array<Partial<GuidanceStep>>;
      instruction?: string;
      targetSelector?: string;
      targetText?: string;
      fallbackText?: string;
      waitFor?: string;
      isComplete?: boolean;
      message?: string;
    };

    const rawSteps: Array<Partial<GuidanceStep>> = Array.isArray(parsed.steps)
      ? parsed.steps
      : parsed.instruction
        ? [parsed]
        : [];

    if (rawSteps.length === 0) {
      throw new Error("No steps returned");
    }

    const steps: GuidanceStep[] = rawSteps.map((step, index) => ({
      instruction: (step.instruction ?? "").trim(),
      targetSelector: (step.targetSelector ?? step.targetText ?? "").trim(),
      targetText: (step.targetText ?? step.targetSelector ?? "").trim(),
      fallbackText: (step.fallbackText ?? "").trim(),
      waitFor: (step.waitFor ?? "").trim(),
      stepIndex: request.history.length + index,
    }));

    return {
      success: true,
      steps,
      isComplete: parsed.isComplete === true,
      message: parsed.message,
    };
  } catch {
    const extractedInstruction = extractInstructionFromText(responseText);

    if (extractedInstruction) {
      return {
        success: true,
        steps: [
          {
            instruction: extractedInstruction,
            targetSelector: "",
            targetText: "",
            fallbackText: "",
            waitFor: "",
            stepIndex: request.history.length,
          },
        ],
        isComplete: false,
        message: "AI returned a non-JSON response.",
      };
    }

    return {
      success: false,
      steps: [getFallbackStep(request)],
      isComplete: false,
      error: "Could not parse AI response.",
    };
  }
}

function extractInstructionFromText(text: string): string | null {
  const cleanText = text.trim();

  if (cleanText.length > 10 && cleanText.length < 200) {
    return cleanText;
  }

  const match = cleanText.match(
    /(Click|Type|Select|Navigate|Open|Enter|Choose|Search|Scroll|Find).+?[.!]/i,
  );

  return match ? match[0] : null;
}

function getFallbackStep(request: NextStepRequest): GuidanceStep {
  return {
    instruction: `Look for the next action related to: "${request.goal}"`,
    targetSelector: "",
    targetText: "",
    fallbackText: "",
    waitFor: "",
    stepIndex: request.history.length,
  };
}
