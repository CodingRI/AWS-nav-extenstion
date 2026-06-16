# AI Agent Context and Development Roadmap

This document serves as a comprehensive system manual and roadmap for the AWS Navigation Assistant project. It is structured to provide external AI coding agents with the exact architectural details, process workflows, file-level boundaries, and current requirements needed to modify the codebase effectively.

---

## System Context and Architecture

The AWS Navigation Assistant is a browser-based guidance system consisting of a Manifest V3 Chrome Extension and a local Express backend. The application dynamically scans the AWS Management Console DOM, parses interactive targets, consults a Large Language Model (LLM) to determine the next operational step, and visually spotlights target elements inside the AWS console.

### File-Level Responsibilities

#### Shared Space

- [shared/src/index.ts](file:///Users/raushan/AWS-nav-extenstion/shared/src/index.ts): Holds the master data-contracts, message type constants (`REQUEST_NEXT_STEP`, `STEP_RESULT`, `STOP_GUIDANCE`), state model definitions (`GuidanceSession`, `GuidanceStep`, `PageContext`), and API response types.

#### Backend

- [backend/src/server.ts](file:///Users/raushan/AWS-nav-extenstion/backend/src/server.ts): Express server entry point. Defines CORS rules to accommodate requests originating from the chrome-extension protocol, initializes middleware, and spins up the HTTP server on port 8000.
- [backend/src/routes/navigation.routes.ts](file:///Users/raushan/AWS-nav-extenstion/backend/src/routes/navigation.routes.ts): Defines the `/api/next-step` route. It validates request parameters (goal, history list, pageContext) and passes them to the AI service.
- [backend/src/services/ai.service.ts](file:///Users/raushan/AWS-nav-extenstion/backend/src/services/ai.service.ts): Formulates prompts for OpenRouter API completions using `openai/gpt-4o`. Implements loop detection rules and transforms the unstructured LLM response back into a strictly structured guidance step JSON object.

#### Extension

- [extension/manifest.json](file:///Users/raushan/AWS-nav-extenstion/extension/manifest.json): Configuration manifest detailing Manifest V3 options, active permissions (`storage`, `activeTab`, `scripting`, `tabs`), extension icons, and matching patterns specifying where content scripts are loaded.
- [extension/background.ts](file:///Users/raushan/AWS-nav-extenstion/extension/background.ts): Background service worker. Functions as a proxy server routing HTTP requests to `http://localhost:8000/api/next-step`. Listens to tab activation changes, and maintains session access permissions across contexts.
- [extension/content/content.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/content.ts): Content script bootstrap file. Handles background page triggers, executes local storage checks, starts navigation monitors, and triggers target click callbacks.
- [extension/content/index.tsx](file:///Users/raushan/AWS-nav-extenstion/extension/content/index.tsx): Content script entry point. Inserts the `#aws-nav-assistant-root` container into the active body of the AWS Console and renders the React App component.
- [extension/content/App.tsx](file:///Users/raushan/AWS-nav-extenstion/extension/content/App.tsx): Main React application. Represents the floating sidebar widget. Controls the session state machine, UI updates, step lists, error displays, retry hooks, and scrolling overlays.
- [extension/content/contextGrabber.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/contextGrabber.ts): Scrapes the page structure. Gathers breadcrumbs, parsed AWS service name (EC2, S3, IAM, etc.), document properties, and ranks interactive DOM targets.
- [extension/content/highlighter.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/highlighter.ts): Element finder. Uses a multi-stage waterfall search strategy starting with tag-hint deterministic matching, then ARIA labels, text content, Shadow DOM traversal, scored matchers, and Levenshtein edit distance. Renders a spotlight overlay with instruction tooltip. Handles iframe coordinate offsets via `getAbsoluteRect()`.
- [extension/content/navigationWatcher.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/navigationWatcher.ts): Listens to dynamic Single Page Application (SPA) navigation transitions by tracking history state mutations and waiting for DOM hierarchies to stabilize.
- [extension/content/sessionManager.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/sessionManager.ts): Manages active session cycles (creating, pausing, resuming, or completing flows) utilizing chrome storage APIs.
- [extension/content/sessionStore.ts](file:///Users/raushan/AWS-nav-extenstion/extension/content/sessionStore.ts): Historical helper code handling local storage persistence.

---

## Operational Lifecycles

The application implements a cyclical step-by-step guidance workflow:

```
[ User inputs Goal ]
         │
         ▼
[ contextGrabber scans AWS console DOM ]
         │
         ▼
[ Payload compiled and sent: POST /api/next-step ]
         │
         ▼
[ Backend AI builds prompt -> Queries GPT-4o via OpenRouter ]
         │
         ▼
[ LLM resolves next action -> returns GuidanceStep JSON ]
         │
         ▼
[ highlighter locates element in DOM (traversing Shadow Roots) ]
         │
         ▼
[ Spotlight Overlay drawn around element + Click interception active ]
         │
         ▼
[ User clicks highlighted element -> Event completes step -> Loop repeats ]
```

---

## Resolved Issues (for historical reference)

The following issues were identified during development and have been resolved:

### Context Grabbing (Resolved)

The context grabber now scans **real action HTML tags only** (`a`, `button`, `input`, `select`, `textarea`) across three DOM layers:

1. **Main document** — standard `querySelectorAll`
2. **Same-origin iframes** — AWS Console renders service content inside iframes; the grabber accesses them via `contentDocument` and recurses into nested iframes
3. **Shadow DOMs** — AWS uses `awsui-*` web components; a `TreeWalker` finds shadow roots and scans inside them

Input elements capture `value`, `placeholder`, `inputType`, and `name`. Labels are resolved via `aria-labelledby` (with shadow root awareness using `getRootNode()`), `aria-label`, `label[for]`, parent labels, `name`, and `placeholder` — in that priority order. Text is capped at 80 chars for buttons/links and 60 chars for input labels to control prompt token usage.

### State Persistence (Resolved)

Session state uses a single storage key (`aws_nav_active_session`) in `chrome.storage.session`. The legacy `sessionStore.ts` key conflict has been superseded by `sessionManager.ts`. On mount, `App.tsx` re-hydrates the session and message history. `stopSession()` fully clears the session from storage so no stale state triggers unwanted LLM calls on navigation.

### Element Matching Accuracy (Resolved)

The highlighter now uses **tag-based deterministic matching** (Strategy 0). When the LLM returns `targetText`, `App.tsx` looks it up in the element list that was sent to the LLM to find the exact `tagName` and CSS `selector`. These are stored as `tagHint` and `selectorHint` on the step. The highlighter searches for elements matching that specific HTML tag with matching text, eliminating false positives from same-text elements of different tag types.

### Input Element Interaction (Resolved)

Input elements (`input`, `textarea`, `select`) no longer auto-advance the guidance step on click. Clicking an input focuses it for typing. The user advances to the next step via the "Next" button. The LLM returns multi-step arrays for form pages (all fields + submit button), cycled locally without extra LLM calls.
