import { grabPageContext } from "./contextGrabber";
import { highlighter } from "./highlighter";
import { watchForNavigation, waitForDomSettle } from "./navigationWatcher";
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

  const pageContext = grabPageContext();

  let result;
  try {
    const response = await fetch("http://localhost:3000/api/next-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal: session.goal,
        pageContext,
        history: session.history,
        sessionId: `tab-${session.tabId}`,
      }),
    });
    result = await response.json();
  } catch (err) {
    console.error("[Content] Backend call failed:", err);
    return;
  }

  if (!result.success) return;

  if (result.isComplete) {
    console.log("[Content] Goal complete!");
    await clearSession();
    highlighter.clearHighlights();
    return;
  }

  const el = await highlighter.highlightStep(result.step);
  if (!el) {
    console.warn("[Content] Element not found:", result.step);
    return;
  }

  highlighter.attachClickDetection(el, async () => {
    // Save BEFORE navigation happens so the new page loads the updated history
    await appendStepToHistory(result.step);
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
  await waitForDomSettle(800, 5000);  // your existing function
  onPageReady();
});

window.addEventListener("beforeunload", stopWatcher);