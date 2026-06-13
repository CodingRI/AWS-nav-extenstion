# AI Agent Context and Development Roadmap

This document serves as a comprehensive system manual and roadmap for the AWS Navigation Assistant project. It is structured to provide external AI coding agents with the exact architectural details, process workflows, file-level boundaries, and current requirements needed to modify the codebase effectively.

---

## System Context and Architecture

The AWS Navigation Assistant is a browser-based guidance system consisting of a Manifest V3 Chrome Extension and a local Express backend. The application dynamically scans the AWS Management Console DOM, parses interactive targets, consults a Large Language Model (LLM) to determine the next operational step, and visually spotlights target elements inside the AWS console.

### Directory Layout

```
. (Workspace Root)
├── backend/                 # Express Server (OpenRouter API Integration)
│   ├── src/
│   │   ├── routes/          # API Route handling (/api/next-step, /api/health)
│   │   ├── services/        # AI Service (Prompt builder & OpenRouter client)
│   │   └── server.ts        # Server entry & CORS configurations
│   └── package.json
├── extension/               # Chrome Extension (React + Vite + TypeScript)
│   ├── content/             # Content scripts running inside the AWS Console
│   │   ├── App.tsx          # Floating chat assistant UI overlay
│   │   ├── App.css          # Styling for the chat widget & overlays
│   │   ├── content.ts       # Main content script entry point
│   │   ├── contextGrabber.ts# Scrapes DOM breadcrumbs, service details, & buttons
│   │   ├── highlighter.ts   # Locates elements (shadow DOM) & displays highlights
│   │   ├── navigationWatcher.ts # Watches SPA and visibility changes
│   │   ├── sessionManager.ts# Session controller (using storage key "aws_nav_active_session")
│   │   └── sessionStore.ts  # Legacy store (using storage key "aws_nav_session")
│   ├── src/                 # Extension popup panel (Standard SPA boilerplate)
│   ├── background.ts        # Service worker proxying fetch calls to the backend
│   └── manifest.json        # Extension Manifest V3 configuration
└── shared/                  # Shared types and message declarations
```

### File-Level Responsibilities

#### Shared Space
* [shared/src/index.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/shared/src/index.ts): Holds the master data-contracts, message type constants (`REQUEST_NEXT_STEP`, `STEP_RESULT`, `STOP_GUIDANCE`), state model definitions (`GuidanceSession`, `GuidanceStep`, `PageContext`), and API response types.

#### Backend
* [backend/src/server.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/backend/src/server.ts): Express server entry point. Defines CORS rules to accommodate requests originating from the chrome-extension protocol, initializes middleware, and spins up the HTTP server on port 3000.
* [backend/src/routes/navigation.routes.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/backend/src/routes/navigation.routes.ts): Defines the `/api/next-step` route. It validates request parameters (goal, history list, pageContext) and passes them to the AI service.
* [backend/src/services/ai.service.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/backend/src/services/ai.service.ts): Formulates prompts for OpenRouter API completions using `openai/gpt-4o`. Implements loop detection rules and transforms the unstructured LLM response back into a strictly structured guidance step JSON object.

#### Extension
* [extension/manifest.json](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/manifest.json): Configuration manifest detailing Manifest V3 options, active permissions (`storage`, `activeTab`, `scripting`, `tabs`), extension icons, and matching patterns specifying where content scripts are loaded.
* [extension/background.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/background.ts): Background service worker. Functions as a proxy server routing HTTP requests to `http://localhost:3000/api/next-step`. Listens to tab activation changes, and maintains session access permissions across contexts.
* [extension/content/content.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/content.ts): Content script bootstrap file. Handles background page triggers, executes local storage checks, starts navigation monitors, and triggers target click callbacks.
* [extension/content/index.tsx](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/index.tsx): Content script entry point. Inserts the `#aws-nav-assistant-root` container into the active body of the AWS Console and renders the React App component.
* [extension/content/App.tsx](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/App.tsx): Main React application. Represents the floating sidebar widget. Controls the session state machine, UI updates, step lists, error displays, retry hooks, and scrolling overlays.
* [extension/content/contextGrabber.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/contextGrabber.ts): Scrapes the page structure. Gathers breadcrumbs, parsed AWS service name (EC2, S3, IAM, etc.), document properties, and ranks interactive DOM targets.
* [extension/content/highlighter.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/highlighter.ts): Element finder. Uses a multi-stage search strategy (waterfall search: exact ARIA, text contents, Shadow DOM components, scored matchers, Levenshtein edit distance calculations) to isolate targeted elements, then constructs a Canvas spotlight overlay.
* [extension/content/navigationWatcher.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/navigationWatcher.ts): Listens to dynamic Single Page Application (SPA) navigation transitions by tracking history state mutations and waiting for DOM hierarchies to stabilize.
* [extension/content/sessionManager.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/sessionManager.ts): Manages active session cycles (creating, pausing, resuming, or completing flows) utilizing chrome storage APIs.
* [extension/content/sessionStore.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/sessionStore.ts): Historical helper code handling local storage persistence.

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

## Known Issues and Enhancement Requirements

The following two development requirements must be resolved in the codebase:

### Requirement 1: Improved Context Grabbing (`contextGrabber.ts`)

#### The Problem
In the AWS Management Console (especially inside complex environments like the EC2 instances dashboard), critical actions and navigation controls (such as the main "Launch instance" button) are frequently built using nested elements inside generic `div` or `span` elements, or contain custom layout structures.
* Currently, `scanAndRankElements()` queries only explicit interactives:
  ```ts
  'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input:not([type="hidden"]), select, textarea'
  ```
* Because wrapper `div` and `span` tags are ignored, custom action elements that lack formal HTML role descriptors are omitted. Consequently, the LLM prompt does not receive them in the context block, which breaks navigation paths.

#### The viable Solution(try to go through it and see if it works, if it doesn't sound good add some other logics for optimization)
Enhance the scanning process in [contextGrabber.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/contextGrabber.ts):
1. **Extend Element Selectors:** Include `div` and `span` elements in the queried candidates if they represent interactive targets.
2. **Interactive Filtering Rules:** Apply strict filters to separate actionable wrappers from general structural divs:
   * Evaluate CSS cursor styling (e.g. `cursor: pointer`).
   * Check for presence of inline `onclick` event properties.
   * Look for specific attributes that indicate interactive contexts (such as `data-analytics-metadata` containing button actions or command text).
   * Include elements containing compact action instructions that wrap smaller clickable items, provided they are not located too deep in the hierarchy.
3. **De-duplication:** Prevent nested duplicates. If a container `div` wraps an already captured `button`, do not add both elements to the context list. Prefer the leaf element.
4. **Token Control:** Do not include general structural divs containing long paragraphs or large text blocks. Text labels for captured elements must remain short (capped at 80-120 characters) to avoid exceeding the prompt length limits.

---

### Requirement 2: Reliable State Persistence Across Refreshes

#### The Problem
Refreshing the active AWS Console window clears the extension memory space and breaks the current guidance state, resetting the user to the initial welcome screen.
* **Storage Key Conflicts:** The code implements two different storage stores with different keys:
  * [sessionStore.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/sessionStore.ts) records states under the key `"aws_nav_session"`.
  * [sessionManager.ts](file:///Users/riyakarmakar/Documents/AWS%20navigation%20ext/extension/content/sessionManager.ts) records states under the key `"aws_nav_active_session"`.
* **State Loss on Reload:** When a page reload occurs, the content scripts and React App (`App.tsx`) unmount and rebuild. The initialization code fails to consistently retrieve or re-hydrate the existing state before rendering.


