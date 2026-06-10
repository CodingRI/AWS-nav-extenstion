import type { GuidanceStep } from "@aws-nav/shared";

export interface GuidanceSession {
  goal: string;
  history: GuidanceStep[];
  stepIndex: number;
  tabId: number;
  startedAt: number;
}

const KEY = "aws_nav_session";

export async function saveSession(s: GuidanceSession): Promise<void> {
  await chrome.storage.session.set({ [KEY]: s });
}

export async function loadSession(): Promise<GuidanceSession | null> {
  const result = await chrome.storage.session.get(KEY);
  return (result[KEY] as GuidanceSession) ?? null;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}

export async function appendStepToHistory(step: GuidanceStep): Promise<void> {
  const session = await loadSession();
  if (!session) return;
  session.history.push(step);
  session.stepIndex = session.history.length;
  await saveSession(session);
}