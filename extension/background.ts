import type {
  ExtensionMessage,
  NextStepRequest,
  NextStepResponse,
  OpenRouterModel,
  OpenRouterValidationResult,
  RuntimeResult,
  ValidateOpenRouterKeyPayload,
} from "@aws-nav/shared";
import { OpenRouterRequestError } from "./src/openrouter/errors";
import { MessageType } from "./src/backgroundMessageTypes";
import { openRouterClient } from "./src/openrouter/client";

// Track which tab has the active AWS guidance session
let guidanceTabId: number | null = null;

// Listen for messages from content script
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    console.log("[Background] Received message:", message.type);

    switch (message.type) {
      case MessageType.REQUEST_NEXT_STEP:
        if (sender.tab?.id) {
          guidanceTabId = sender.tab.id;
        }
        void handleNextStepRequest(
          message.payload as NextStepRequest,
          sendResponse as (response: RuntimeResult<NextStepResponse>) => void,
        );
        return true;

      case MessageType.VALIDATE_OPENROUTER_KEY:
        void handleValidateKey(
          message.payload as ValidateOpenRouterKeyPayload,
          sendResponse as (
            response: RuntimeResult<OpenRouterValidationResult>,
          ) => void,
        );
        return true;

      case MessageType.LIST_OPENROUTER_MODELS:
        void handleListModels(
          sendResponse as (response: RuntimeResult<OpenRouterModel[]>) => void,
        );
        return true;

      case MessageType.STOP_GUIDANCE:
        guidanceTabId = null;
        sendResponse({ success: true });
        break;

      case MessageType.PAUSE_GUIDANCE:
        // Keep tracking the tab even when paused
        sendResponse({ success: true });
        break;

      case MessageType.RESUME_GUIDANCE:
        if (sender.tab?.id) {
          guidanceTabId = sender.tab.id;
        }
        sendResponse({ success: true });
        break;

      default:
        console.warn("[Background] Unknown message type:", message.type);
    }
  },
);

async function handleNextStepRequest(
  payload: NextStepRequest,
  sendResponse: (response: RuntimeResult<NextStepResponse>) => void,
): Promise<void> {
  try {
    const data = await openRouterClient.generateNextStep(payload);
    sendResponse({ success: true, data });
  } catch (error) {
    sendOpenRouterError(sendResponse, error);
  }
}

async function handleValidateKey(
  payload: ValidateOpenRouterKeyPayload,
  sendResponse: (response: RuntimeResult<OpenRouterValidationResult>) => void,
): Promise<void> {
  try {
    const data = await openRouterClient.validateApiKey(payload.apiKey);
    sendResponse({ success: true, data });
  } catch (error) {
    sendOpenRouterError(sendResponse, error);
  }
}

async function handleListModels(
  sendResponse: (response: RuntimeResult<OpenRouterModel[]>) => void,
): Promise<void> {
  try {
    const data = await openRouterClient.listModels();
    sendResponse({ success: true, data });
  } catch (error) {
    sendOpenRouterError(sendResponse, error);
  }
}

function sendOpenRouterError<TData>(
  sendResponse: (response: RuntimeResult<TData>) => void,
  error: unknown,
): void {
  if (error instanceof OpenRouterRequestError) {
    sendResponse({
      success: false,
      error: error.details,
    });
    return;
  }

  sendResponse({
    success: false,
    error: {
      code: "unknown_error",
      message: error instanceof Error ? error.message : "Unknown error",
    },
  });
}

/* ========================================================================
   TAB TRACKING — Detect when user leaves/returns to the AWS tab
   ======================================================================== */

/**
 * When user switches to the tab with active guidance,
 * send a message to the content script so it can re-highlight.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!guidanceTabId) return;

  if (activeInfo.tabId === guidanceTabId) {
    console.log("[Background] User returned to guidance tab");
    try {
      await chrome.tabs.sendMessage(guidanceTabId, {
        type: "AWS_NAV_TAB_RETURNED",
      });
    } catch (err) {
      // Content script may not be ready yet
      console.warn("[Background] Could not notify content script:", err);
    }
  } else {
    console.log("[Background] User left guidance tab");
    try {
      await chrome.tabs.sendMessage(guidanceTabId, {
        type: "AWS_NAV_TAB_LEFT",
      });
    } catch (err) {
      console.warn("[Background] Could not notify content script:", err);
    }
  }
});

/**
 * Track tab URL changes (catches address bar navigation on the guidance tab).
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === guidanceTabId && changeInfo.url) {
    console.log("[Background] Guidance tab URL changed:", changeInfo.url);
    // The content script's navigation watcher handles this,
    // but we log it here for debugging
  }
});

/**
 * If the guidance tab is closed, clear tracking.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === guidanceTabId) {
    console.log("[Background] Guidance tab closed");
    guidanceTabId = null;
  }
});

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log("[Background] Extension installed:", details.reason);

  // Enable session storage access for content scripts
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session
      .setAccessLevel({
        accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
      })
      .then(() => {
        console.log(
          "[Background] Session storage access level set to TRUSTED_AND_UNTRUSTED_CONTEXTS (onInstalled)",
        );
      })
      .catch((err) => {
        console.error(
          "[Background] Failed to set session storage access level:",
          err,
        );
      });
  }

  if (details.reason === "install") {
    chrome.storage.local.set({
      settings: {
        autoHighlight: true,
        highlightColor: "#00D9FF",
      },
    });
  }
});

// Enable session storage access for content scripts on startup
if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session
    .setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
    })
    .then(() => {
      console.log(
        "[Background] Session storage access level set to TRUSTED_AND_UNTRUSTED_CONTEXTS (startup)",
      );
    })
    .catch((err) => {
      console.error(
        "[Background] Failed to set session storage access level:",
        err,
      );
    });
}

// Log when service worker starts
console.log(
  "[Background] Service worker initialized (OpenRouter BYOK mode)",
);
