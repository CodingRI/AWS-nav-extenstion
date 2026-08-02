// ============================================================
// AWS Navigation Assistant — Shared Types
// ============================================================

// ----- Message Types (content script ↔ background) -----

export const MessageType = {
  REQUEST_NEXT_STEP: "REQUEST_NEXT_STEP",
  STEP_RESULT: "STEP_RESULT",
  GRAB_CONTEXT: "GRAB_CONTEXT",
  CONTEXT_RESULT: "CONTEXT_RESULT",
  VALIDATE_OPENROUTER_KEY: "VALIDATE_OPENROUTER_KEY",
  LIST_OPENROUTER_MODELS: "LIST_OPENROUTER_MODELS",
  PAUSE_GUIDANCE: "PAUSE_GUIDANCE",
  RESUME_GUIDANCE: "RESUME_GUIDANCE",
  STOP_GUIDANCE: "STOP_GUIDANCE",
  HIGHLIGHT_ELEMENT: "HIGHLIGHT_ELEMENT",
  CLEAR_HIGHLIGHTS: "CLEAR_HIGHLIGHTS",
  PAGE_CHANGED: "PAGE_CHANGED",
  GUIDE_COMPLETED: "GUIDE_COMPLETED",
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

// ----- Page Context -----

/** A single interactive element found on the page. */
export interface InteractiveElement {
  tagName: string;
  text: string;
  ariaLabel: string | null;
  dataAnalytics: string | null;
  role: string | null;
  selector: string;
  isVisible: boolean;
  value?: string;
  placeholder?: string;
  inputType?: string;
  name?: string;
}

/** Full context of the current AWS Console page. */
export interface PageContext {
  url: string;
  service: string;
  view: string;
  title: string;
  visibleButtons: InteractiveElement[];
  breadcrumb: string[];
  formState: Record<string, string>;
}

// ----- Guidance -----

export interface GuidanceStep {
  instruction: string;
  targetSelector: string;
  targetText: string;
  fallbackText: string;
  waitFor: string;
  stepIndex: number;
  pageUrl?: string;
  completedAt?: number;
  tagHint?: string;
  selectorHint?: string;
}

export interface SessionMessage {
  id: string;
  type: "user" | "assistant" | "system" | "error";
  content: string;
  timestamp: number;
  retryAction?: "retry-step" | "retry-fresh";
}

export type GuidanceStatus = "active" | "paused" | "completed" | "stopped";

export interface GuidanceSession {
  sessionId: string;
  goal: string;
  steps: GuidanceStep[];
  currentStepIndex: number;
  status: GuidanceStatus;
  activeUrl: string;
  pausedUrl?: string;
  pausedStepInstruction?: string;
  lastActivityTimestamp: number;
  createdAt: number;
  messages?: SessionMessage[];
}

export interface NextStepRequest {
  goal: string;
  pageContext: PageContext;
  history: GuidanceStep[];
  sessionId?: string;
}

export interface NextStepResponse {
  success: boolean;
  steps: GuidanceStep[];
  isComplete: boolean;
  message?: string;
  error?: string;
}

// ----- OpenRouter -----

export interface OpenRouterConfiguration {
  apiKey: string;
  selectedModel: string;
  savedAt: number;
}

export interface OpenRouterConfigurationStatus {
  hasApiKey: boolean;
  selectedModel: string | null;
  isConfigured: boolean;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  promptPricing?: string;
  completionPricing?: string;
}

export interface OpenRouterRawModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

export interface OpenRouterModelsResponse {
  data: OpenRouterRawModel[];
}

export interface OpenRouterChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export type OpenRouterErrorCode =
  | "not_configured"
  | "invalid_key"
  | "auth_invalidated"
  | "rate_limited"
  | "out_of_credits"
  | "network_error"
  | "server_error"
  | "unknown_error";

export interface OpenRouterClientError {
  code: OpenRouterErrorCode;
  message: string;
  status?: number;
  shouldClearConfiguration?: boolean;
}

export interface OpenRouterValidationResult {
  models: OpenRouterModel[];
  suggestedModel: string;
}

// ----- Runtime Messages -----

export interface ExtensionMessage<TPayload = unknown> {
  type: MessageTypeValue;
  payload?: TPayload;
}

export interface RuntimeResult<TData> {
  success: boolean;
  data?: TData;
  error?: OpenRouterClientError;
}

export interface ValidateOpenRouterKeyPayload {
  apiKey: string;
}

export interface NextStepMessage extends ExtensionMessage<NextStepRequest> {
  type: typeof MessageType.REQUEST_NEXT_STEP;
  payload: NextStepRequest;
}

export interface StepResultMessage extends ExtensionMessage<NextStepResponse> {
  type: typeof MessageType.STEP_RESULT;
  payload: NextStepResponse;
}

// ----- Storage Types -----

export interface SessionStorage {
  activeSession: GuidanceSession | null;
}

// ----- Highlight Styles -----

export interface HighlightStyle {
  outline?: string;
  boxShadow?: string;
  backgroundColor?: string;
  zIndex?: number;
  animation?: string;
}