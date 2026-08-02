import { grabPageContext } from "./contextGrabber";
import { highlighter } from "./highlighter";
import { watchForNavigation, waitForDomSettle } from "./navigationWatcher";
import type { NextStepResponse, RuntimeResult } from "@aws-nav/shared";
import { MessageType } from "./messageTypes";
import {
  loadSession,
  saveSession,
  clearSession,
  appendStepToHistory,
} from "./sessionStore";

async function onPageReady(): Promise<void> {
  const session = await loadSession();

  if (!session) {
    console.log("[Content] No active session");
    return;
  }

  console.log("[Content] Resuming:", session.goal, "| step", session.stepIndex);

  const pageContext = await grabPageContext();

  let result: NextStepResponse | null = null;
  try {
    const response = await new Promise<RuntimeResult<NextStepResponse>>(
      (resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: MessageType.REQUEST_NEXT_STEP,
            payload: {
              goal: session.goal,
              pageContext,
              history: session.history,
              sessionId: `tab-${session.tabId}`,
            },
          },
          (runtimeResponse: RuntimeResult<NextStepResponse>) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
              return;
            }
            resolve(runtimeResponse);
          },
        );
      },
    );

    if (!response.success || !response.data) {
      console.error("[Content] OpenRouter call failed:", response.error?.message);
      return;
    }

    result = response.data;
  } catch (err) {
    console.error("[Content] OpenRouter call failed:", err);
    return;
  }

  if (!result?.success) return;

  if (result.isComplete) {
    console.log("[Content] Goal complete!");
    await clearSession();
    highlighter.clearHighlights();
    return;
  }

  const firstStep = result.steps[0];
  if (!firstStep) return;

  const el = await highlighter.highlightStep(firstStep);
  if (!el) {
    console.warn("[Content] Element not found:", firstStep);
    return;
  }

  highlighter.attachClickDetection(el, async () => {
    await appendStepToHistory(firstStep);
  });
}

// ── Messages from your sidebar UI ────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_SESSION") {
    chrome.tabs.getCurrent((tab) => {
      saveSession({
        goal: message.goal,
        history: [],
        stepIndex: 0,
        tabId: tab?.id ?? 0,
        startedAt: Date.now(),
      }).then(() => {
        onPageReady();
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "CLEAR_SESSION") {
    clearSession().then(() => {
      highlighter.clearHighlights();
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ── Boot ─────────────────────────────────────────────────────
onPageReady();

// After every SPA navigation, wait for DOM to settle then re-run
const stopWatcher = watchForNavigation(async (newUrl) => {
  console.log("[Content] Navigation to:", newUrl);
  await waitForDomSettle(800, 5000); // your existing function
  onPageReady();
});

window.addEventListener("beforeunload", stopWatcher);
