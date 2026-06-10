// ============================================================
// AWS Navigation Assistant — Shared Types (v2)
// ============================================================

// ----- Message Types (content script ↔ background ↔ backend) -----

export const MessageType = {
  // New dynamic flow
  REQUEST_NEXT_STEP: "REQUEST_NEXT_STEP",
  STEP_RESULT: "STEP_RESULT",
  GRAB_CONTEXT: "GRAB_CONTEXT",
  CONTEXT_RESULT: "CONTEXT_RESULT",

  // Guidance lifecycle
  PAUSE_GUIDANCE: "PAUSE_GUIDANCE",
  RESUME_GUIDANCE: "RESUME_GUIDANCE",
  STOP_GUIDANCE: "STOP_GUIDANCE",

  // Legacy (kept for reference, will be removed in Chunk 3)
  HIGHLIGHT_ELEMENT: "HIGHLIGHT_ELEMENT",
  CLEAR_HIGHLIGHTS: "CLEAR_HIGHLIGHTS",
  PAGE_CHANGED: "PAGE_CHANGED",
  GUIDE_COMPLETED: "GUIDE_COMPLETED",
} as const;

export type MessageTypeValue =
  (typeof MessageType)[keyof typeof MessageType];

// ----- Page Context (Phase 1 output) -----

/** A single interactive element found on the page */
export interface InteractiveElement {
  tagName: string;
  text: string;
  ariaLabel: string | null;
  dataAnalytics: string | null;
  role: string | null;
  selector: string;        // best-effort CSS selector for this element
  isVisible: boolean;
}

/** Full context of the current AWS Console page */
export interface PageContext {
  url: string;
  service: string;         // e.g. "EC2", "S3", "IAM"
  view: string;            // e.g. "Instances list", "Bucket details"
  title: string;           // document.title
  visibleButtons: InteractiveElement[];
  breadcrumb: string[];
  formState: Record<string, string>;  // open form fields, active tabs, etc.
}

// ----- Guidance Step (Phase 3 output — from LLM) -----

export interface GuidanceStep {
  instruction: string;     // human-readable: "Click the 'Create bucket' button"
  targetSelector: string;  // ARIA label, text label, or CSS selector
  targetText: string;      // visible text of the target element
  waitFor: string;         // what should appear after clicking (for DOM settle)
  stepIndex: number;       // 0-based, incremented by session manager
  pageUrl?: string;        // URL where this step was issued
  completedAt?: number;    // timestamp when user clicked the target
}

// ----- Guidance Session (persisted across SPA navigations) -----

export interface SessionMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
  retryAction?: 'retry-step' | 'retry-fresh';
}

export type GuidanceStatus = "active" | "paused" | "completed" | "stopped";

export interface GuidanceSession {
  sessionId: string;
  goal: string;
  steps: GuidanceStep[];
  currentStepIndex: number;
  status: GuidanceStatus;
  activeUrl: string;       // URL where guidance is currently active
  pausedUrl?: string;      // URL where guidance was paused (for auto-resume)
  pausedStepInstruction?: string; // instruction of the step that was active when paused
  lastActivityTimestamp: number;
  createdAt: number;
  messages?: SessionMessage[];
}

// ----- API Request / Response (content script → backend) -----

export interface NextStepRequest {
  goal: string;
  pageContext: PageContext;
  history: GuidanceStep[];
  sessionId?: string;
}

export interface NextStepResponse {
  success: boolean;
  step: GuidanceStep;
  isComplete: boolean;     // true when AI says the goal is done
  message?: string;        // optional AI message (e.g. "Goal complete!")
  error?: string;
}

// ----- Extension Messages (content script ↔ background) -----

export interface ExtensionMessage {
  type: MessageTypeValue;
  payload?: any;
}

export interface NextStepMessage extends ExtensionMessage {
  type: typeof MessageType.REQUEST_NEXT_STEP;
  payload: NextStepRequest;
}

export interface StepResultMessage extends ExtensionMessage {
  type: typeof MessageType.STEP_RESULT;
  payload: NextStepResponse;
}

// ----- Storage Types -----

export interface SessionStorage {
  activeSession: GuidanceSession | null;
}

// ----- Highlight Styles (kept for reference) -----

export interface HighlightStyle {
  outline?: string;
  boxShadow?: string;
  backgroundColor?: string;
  zIndex?: number;
  animation?: string;
}