// ============================================================
// Session Manager
// Persists guidance state across AWS SPA navigations using
// chrome.storage.session. Handles create/pause/resume/stop.
// ============================================================

import type { GuidanceSession, GuidanceStep, GuidanceStatus, SessionMessage } from "@aws-nav/shared";

const SESSION_KEY = "aws_nav_active_session";
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if the extension context is still valid.
 * When an extension is reloaded, old content script instances
 * lose their runtime context and chrome.storage calls throw.
 */
function isContextValid(): boolean {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a new guidance session.
 */
export async function createSession(goal: string, startUrl: string): Promise<GuidanceSession> {
  const session: GuidanceSession = {
    sessionId: generateSessionId(),
    goal,
    steps: [],
    currentStepIndex: 0,
    status: "active",
    activeUrl: startUrl,
    lastActivityTimestamp: Date.now(),
    createdAt: Date.now(),
  };

  await saveSession(session);
  console.log("[SessionManager] Created session:", session.sessionId);
  return session;
}

/**
 * Get the currently active session. Returns null if none exists or if expired.
 */
export async function getActiveSession(): Promise<GuidanceSession | null> {
  if (!isContextValid()) return null;
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);

    const session = result[SESSION_KEY] as GuidanceSession | undefined;

    if (!session) return null;

    // Check if expired
    if (isSessionExpired(session)) {
      console.log("[SessionManager] Session expired, clearing");
      await clearSession();
      return null;
    }

    return session;
  } catch (err: any) {
    // Silently ignore context invalidation — happens when extension is reloaded
    // and old content script instances are still running
    const msg = err?.message || "";
    if (
      msg.includes("Extension context invalidated") ||
      msg.includes("not allowed from this context") ||
      msg.includes("Cannot access")
    ) {
      return null; // silent — this is expected
    }
    console.warn("[SessionManager] Error reading session:", err);
    return null;
  }
}

/**
 * Add a completed step to the session.
 */
export async function addStep(step: GuidanceStep): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session) return null;

  session.steps.push(step);
  session.currentStepIndex = session.steps.length;
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  console.log("[SessionManager] Step added:", step.stepIndex, step.instruction);
  return session;
}

/**
 * Record that the current step was completed (user clicked the target).
 */
export async function completeCurrentStep(): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session || session.steps.length === 0) return null;

  const lastStep = session.steps[session.steps.length - 1];
  lastStep.completedAt = Date.now();
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  return session;
}

/**
 * Pause the session (user navigated away or clicked something else).
 * Records the URL and step instruction so we can auto-resume later.
 */
export async function pauseSession(reason?: string): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session) return null;

  session.status = "paused";
  session.pausedUrl = session.activeUrl;
  session.lastActivityTimestamp = Date.now();

  // Record which step was active when paused
  const lastStep = session.steps[session.steps.length - 1];
  if (lastStep && !lastStep.completedAt) {
    session.pausedStepInstruction = lastStep.instruction;
  }

  await saveSession(session);
  console.log(`[SessionManager] Session paused at ${session.pausedUrl} (reason: ${reason || 'unknown'})`);
  return session;
}

/**
 * Resume a paused session.
 * Clears the paused URL and instruction since we're active again.
 */
export async function resumeSession(): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session || session.status !== "paused") return null;

  session.status = "active";
  session.pausedUrl = undefined;
  session.pausedStepInstruction = undefined;
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  console.log("[SessionManager] Session resumed");
  return session;
}

/**
 * Stop the session (user explicitly clicked Stop).
 */
export async function stopSession(): Promise<void> {
  const session = await getActiveSession();
  if (session) {
    session.status = "stopped";
    await saveSession(session);
  }
  console.log("[SessionManager] Session stopped");
}

/**
 * Mark session as completed (AI says goal is done).
 */
export async function completeSession(): Promise<void> {
  const session = await getActiveSession();
  if (session) {
    session.status = "completed";
    await saveSession(session);
  }
  console.log("[SessionManager] Session completed");
}

/**
 * Update the active URL (e.g., after SPA navigation).
 */
export async function updateActiveUrl(url: string): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session) return null;

  session.activeUrl = url;
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  return session;
}

/**
 * Update session status.
 */
export async function updateStatus(status: GuidanceStatus): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session) return null;

  session.status = status;
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  return session;
}

/**
 * Clear the session entirely.
 */
export async function clearSession(): Promise<void> {
  try {
    await chrome.storage.session.remove(SESSION_KEY);
    console.log("[SessionManager] Session cleared");
  } catch (err) {
    console.warn("[SessionManager] Error clearing session:", err);
  }
}

/**
 * Check if a session has expired.
 */
export function isSessionExpired(session: GuidanceSession): boolean {
  return Date.now() - session.lastActivityTimestamp > SESSION_TIMEOUT_MS;
}

/**
 * Get the history of completed steps (for sending to AI).
 */
export function getCompletedSteps(session: GuidanceSession): GuidanceStep[] {
  return session.steps.filter((s) => s.completedAt != null);
}

/**
 * Check if we should auto-resume based on the current URL.
 * Returns true if the current URL matches (or is very close to) the paused URL.
 */
export function shouldAutoResume(session: GuidanceSession, currentUrl: string): boolean {
  if (session.status !== "paused" || !session.pausedUrl) return false;

  // Exact match
  if (currentUrl === session.pausedUrl) return true;

  // Loose match: same origin + pathname (ignore query params / hash)
  try {
    const current = new URL(currentUrl);
    const paused = new URL(session.pausedUrl);
    return current.origin === paused.origin && current.pathname === paused.pathname;
  } catch {
    return false;
  }
}

/**
 * Get the last pending (uncompleted) step, if any.
 */
export function getLastPendingStep(session: GuidanceSession): GuidanceStep | null {
  if (session.steps.length === 0) return null;
  const lastStep = session.steps[session.steps.length - 1];
  return lastStep && !lastStep.completedAt ? lastStep : null;
}

/**
 * Check if the session has expired and handle cleanup.
 * Returns true if the session was expired and cleaned up.
 */
export async function checkAndHandleExpiry(): Promise<boolean> {
  const session = await getActiveSession();
  // getActiveSession already checks expiry and clears if needed
  // So if it returns null but there was a session, it was expired
  if (!session) return true; // either no session or expired
  return false;
}

/**
 * Update the session's message list.
 */
export async function updateSessionMessages(messages: SessionMessage[]): Promise<GuidanceSession | null> {
  const session = await getActiveSession();
  if (!session) return null;

  session.messages = messages;
  session.lastActivityTimestamp = Date.now();

  await saveSession(session);
  return session;
}

// ---- Internal ----

async function saveSession(session: GuidanceSession): Promise<void> {
  if (!isContextValid()) return; // extension was reloaded, context gone
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: session });
  } catch (err) {
    console.warn("[SessionManager] Error saving session:", err);
  }
}

