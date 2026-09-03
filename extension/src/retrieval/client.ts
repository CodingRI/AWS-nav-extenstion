import type {
  RetrievalRequest,
  RetrievalResponse,
  RetrievalResult,
} from "@aws-nav/shared";

const DEFAULT_BACKEND_URL = "http://localhost:8000";
const BACKEND_URL_STORAGE_KEY = "retrievalBackendUrl";

/**
 * How long the extension waits for knowledge before giving up.
 *
 * Deliberately shorter than the backend's own retrieval budget: a slow or
 * absent knowledge service must never make guidance feel slower than it did
 * before the retrieval layer existed.
 */
const RETRIEVAL_TIMEOUT_MS = 2000;

/**
 * Remembered failure state. The knowledge base is optional infrastructure, so
 * once it looks absent we stop hammering it on every step of the session and
 * retry only occasionally.
 */
const FAILURE_BACKOFF_MS = 60_000;
let unavailableUntil = 0;

async function resolveBackendUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(BACKEND_URL_STORAGE_KEY);
    const configured = stored[BACKEND_URL_STORAGE_KEY];

    if (typeof configured === "string" && configured.trim()) {
      return configured.trim().replace(/\/$/, "");
    }
  } catch {
    // Storage is unavailable in some contexts; fall through to the default.
  }

  return DEFAULT_BACKEND_URL;
}

/**
 * Trims the page context down to what the ranker actually reads.
 *
 * A busy AWS page yields hundreds of elements, and posting all of them to the
 * retrieval endpoint wastes bandwidth on fields (selectors, analytics
 * attributes) that no ranking feature looks at.
 */
function trimForRetrieval(request: RetrievalRequest): RetrievalRequest {
  const { pageContext } = request;

  return {
    ...request,
    pageContext: {
      ...pageContext,
      visibleButtons: pageContext.visibleButtons.map((element) => ({
        tagName: element.tagName,
        text: element.text,
        ariaLabel: element.ariaLabel,
        dataAnalytics: null,
        role: element.role,
        selector: "",
        isVisible: true,
      })),
    },
  };
}

/**
 * Fetches knowledge base context for a goal.
 *
 * Returns null rather than throwing on every failure path. The caller then
 * prompts exactly as it did before this layer existed, so a stopped backend
 * degrades guidance quality instead of breaking it.
 */
export async function fetchRetrievalContext(
  request: RetrievalRequest,
): Promise<RetrievalResult | null> {
  if (Date.now() < unavailableUntil) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RETRIEVAL_TIMEOUT_MS);

  try {
    const baseUrl = await resolveBackendUrl();

    const response = await fetch(`${baseUrl}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trimForRetrieval(request)),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `[Retrieval] Backend returned ${response.status}; continuing without knowledge.`,
      );
      unavailableUntil = Date.now() + FAILURE_BACKOFF_MS;
      return null;
    }

    const payload = (await response.json()) as RetrievalResponse;

    if (!payload.success || !payload.result) {
      return null;
    }

    unavailableUntil = 0;
    const { result } = payload;

    if (result.documents.length > 0) {
      console.log(
        `[Retrieval] ${result.documents.length} document(s) in ${result.latencyMs}ms:`,
        result.documents.map((entry) => `${entry.document.id}@${entry.score}`).join(", "),
      );
    } else {
      console.log(
        `[Retrieval] No knowledge injected: ${result.decision.reasons[0] ?? "gate skipped"}`,
      );
    }

    return result;
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";

    console.warn(
      isTimeout
        ? `[Retrieval] Timed out after ${RETRIEVAL_TIMEOUT_MS}ms; continuing without knowledge.`
        : "[Retrieval] Unreachable; continuing without knowledge.",
    );

    unavailableUntil = Date.now() + FAILURE_BACKOFF_MS;
    return null;
  } finally {
    clearTimeout(timer);
  }
}
