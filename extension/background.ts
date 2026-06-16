import { MessageType } from "@aws-nav/shared";
import type {
  ExtensionMessage,
  NextStepRequest,
  NextStepResponse,
} from "@aws-nav/shared";

const BACKEND_URL = "http://localhost:8000";

// Track which tab has the active AWS guidance session
let guidanceTabId: number | null = null;

// Listen for messages from content script
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    console.log("[Background] Received message:", message.type);

    switch (message.type) {
      case MessageType.REQUEST_NEXT_STEP:
        // Track which tab is running guidance
        if (sender.tab?.id) {
          guidanceTabId = sender.tab.id;
        }
        handleNextStepRequest(message.payload as NextStepRequest, sendResponse);
        return true; // Keep channel open for async response

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

/**
 * Proxy next-step requests from content script to backend.
 */
async function handleNextStepRequest(
  payload: NextStepRequest,
  sendResponse: (response: any) => void,
) {
  try {
    console.log(
      "[Background] Proxying next-step request for goal:",
      payload.goal,
    );

    const response = await fetch(`${BACKEND_URL}/api/next-step`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: NextStepResponse = await response.json();
    console.log(
      "[Background] Received steps:",
      data.steps?.length,
      data.steps?.[0]?.instruction?.substring(0, 50),
    );

    sendResponse({ success: true, data });
  } catch (error) {
    console.error("[Background] Error:", error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
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
  "[Background] Service worker initialized (v2.2 - with session storage access)",
);
