// Message types for communication between components
// Runtime-safe message constants
export const MessageType = {
  GET_NAVIGATION_STEPS: "GET_NAVIGATION_STEPS",
  HIGHLIGHT_ELEMENT: "HIGHLIGHT_ELEMENT",
  NEXT_STEP: "NEXT_STEP",
  CLEAR_HIGHLIGHTS: "CLEAR_HIGHLIGHTS",
  PAGE_CHANGED: "PAGE_CHANGED",
  GUIDE_COMPLETED: "GUIDE_COMPLETED",
} as const;

// Type of all possible message values
export type MessageTypeValue =
  (typeof MessageType)[keyof typeof MessageType];

  
  // Navigation step structure
  export interface NavigationStep {
    stepNumber: number;
    instruction: string;
    selector: string;
    alternativeSelectors?: string[]; // Fallback selectors
    textContent?: string; // For text-based matching
    page: string; // Expected page URL pattern
    waitForNavigation?: boolean;
    scrollIntoView?: boolean;
  }
  
  // API request/response types
  export interface NavigationRequest {
    query: string;
    currentPage?: string;
  }
  
  export interface NavigationResponse {
    success: boolean;
    steps: NavigationStep[];
    summary: string;
    estimatedTime?: string;
    error?: string;
  }
  
  // Extension message types
  export interface ExtensionMessage {
    type: MessageTypeValue;
    payload?: any;
  }
  
  export interface HighlightMessage extends ExtensionMessage {
    type: typeof MessageType.HIGHLIGHT_ELEMENT;
    payload: {
      stepNumber: number;
      selector: string;
      alternativeSelectors?: string[];
      textContent?: string;
      instruction: string;
    };
  }
  
  export interface NavigationStepsMessage extends ExtensionMessage {
    type: typeof MessageType.GET_NAVIGATION_STEPS;
    payload: {
      query: string;
    };
  }
  
  // Storage types
  export interface SessionState {
    query: string;
    steps: NavigationStep[];
    currentStep: number;
    isActive: boolean;
    startTime: number;
  }
  
  // Highlight styles
  export interface HighlightStyle {
    outline?: string;
    boxShadow?: string;
    backgroundColor?: string;
    zIndex?: number;
    animation?: string;
  }