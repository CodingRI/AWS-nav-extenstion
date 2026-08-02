// ============================================================
// Phase 4 — Element Highlighter (Waterfall Finder + Spotlight)
//
// Finds elements using a robust waterfall strategy:
//   ARIA label → data-analytics → visible text → fuzzy text → CSS selector
// Then renders a spotlight overlay with instruction tooltip.
// ============================================================

import type { GuidanceStep } from "@aws-nav/shared";

export class ElementHighlighter {
  private overlay: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollListeners: Array<() => void> = [];
  private targetClickHandler: (() => void) | null = null;

  private currentTargetElement: HTMLElement | null = null;

  private getAbsoluteRect(el: HTMLElement): DOMRect {
    const rect = el.getBoundingClientRect();
    const ownerDoc = el.ownerDocument;
    if (ownerDoc === document) return rect;

    for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
      try {
        if ((iframe as HTMLIFrameElement).contentDocument === ownerDoc) {
          const iframeRect = iframe.getBoundingClientRect();
          return new DOMRect(
            rect.x + iframeRect.x,
            rect.y + iframeRect.y,
            rect.width,
            rect.height,
          );
        }
      } catch { /* cross-origin */ }
    }
    return rect;
  }

  private getSearchRoots(): Document[] {
    const roots: Document[] = [document];
    for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
      try {
        const doc = (iframe as HTMLIFrameElement).contentDocument;
        if (doc?.body) roots.push(doc);
      } catch { /* cross-origin */ }
    }
    return roots;
  }

  private queryAllRoots(selector: string): HTMLElement[] {
    const results: HTMLElement[] = [];
    for (const root of this.getSearchRoots()) {
      results.push(...(Array.from(root.querySelectorAll(selector)) as HTMLElement[]));
    }
    return results;
  }

  /**
   * Find an element for the given step and spotlight it.
   * Returns the found element, or null if not found.
   */
  async highlightStep(step: GuidanceStep): Promise<HTMLElement | null> {
    this.clearHighlights();

    console.log(`[Highlighter] 🔍 Finding element for: "${step.instruction}"`);
    console.log(`[Highlighter] targetText: "${step.targetText}"`);
    console.log(`[Highlighter] targetSelector: "${step.targetSelector}"`);

    // Find element with retries (AWS DOM may still be loading)
    const el = await this.findWithRetries(step, 15, 500);

    if (!el) {
       console.warn(
    "[Highlighter] Could not locate:",
    step.targetText
  );

  return null;
    }

    console.log("[Highlighter] ✅ Found element:", {
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 60),
      ariaLabel: el.getAttribute("aria-label"),
    });

    // Smart scroll — handle elements inside scrollable containers
    await this.scrollToElement(el);

    // Render spotlight overlay
    this.renderOverlay(el, step.instruction);
    this.currentTargetElement = el;

    return el;
  }

  /**
   * Get info about the last find attempt (for retry-with-re-context).
   */
  getLastFindStrategy(): string {
    return this._lastFindStrategy;
  }

  private _lastFindStrategy: string = "none";

  /**
   * Attach click detection to the highlighted element.
   * - onTargetClick: called when user clicks the highlighted element
   * NOTE: We no longer pause on non-target clicks — the user should be
   * free to scroll, explore, and interact naturally. Guidance only
   * advances when the correct element is clicked.
   */
  attachClickDetection(
    el: HTMLElement,
    onTargetClick: () => void,
  ): void {
    // Clean up any previous handlers
    this.detachClickDetection();

    // Target element click (capture phase to catch before AWS prevents propagation)
    this.targetClickHandler = () => {
      console.log("[Highlighter] ✓ Target element clicked");
      // Clear the overlay IMMEDIATELY — don't wait for async work
      this.clearHighlights();
      onTargetClick();
    };

    el.addEventListener("click", this.targetClickHandler, {
      once: true,
      capture: true,
    });

    // Also listen on mousedown for faster visual response
    const mousedownHandler = () => {
      // Remove the visual overlay on mousedown so it feels instant
      if (this.overlay) {
        this.overlay.style.opacity = "0";
        this.overlay.style.transition = "opacity 0.15s ease";
      }
    };
    el.addEventListener("mousedown", mousedownHandler, {
      once: true,
      capture: true,
    });
  }

  /**
   * Remove click detection handlers.
   */
  detachClickDetection(): void {
    if (this.targetClickHandler && this.currentTargetElement) {
      this.currentTargetElement.removeEventListener(
        "click",
        this.targetClickHandler,
        { capture: true } as EventListenerOptions,
      );
    }
    this.targetClickHandler = null;
  }

  /**
   * Clear all highlights and overlays.
   */
  clearHighlights(): void {
    this.detachClickDetection();

    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.scrollListeners.forEach((cleanup) => cleanup());
    this.scrollListeners = [];
    this.currentTargetElement = null;
  }

  /* ========================================================================
     WATERFALL ELEMENT FINDER
     ======================================================================== */

  /**
   * Try to find the element with retries.
   */
  private async findWithRetries(
    step: GuidanceStep,
    maxRetries: number,
    delayMs: number,
  ): Promise<HTMLElement | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const el = this.findElementSafely(step);
      if (el) {
        console.log(`[Highlighter] Found on attempt ${attempt}/${maxRetries}`);
        return el;
      }

      if (attempt < maxRetries) {
        console.log(`[Highlighter] Retry ${attempt}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return null;
  }

  private findInputElement(targetText: string): HTMLElement | null {
    const label = targetText
      .replace("[input:", "")
      .replace("[textarea:", "")
      .replace("[dropdown:", "")
      .replace("]", "")
      .trim()
      .toLowerCase();

    const selector = 'input, textarea, select, [contenteditable="true"]';
    const allInputs: HTMLElement[] = [];

    // Collect from main doc + iframes
    allInputs.push(...this.queryAllRoots(selector));

    // Collect from shadow DOMs across all roots
    for (const root of this.getSearchRoots()) {
      const body = root.body;
      if (!body) continue;
      const walker = root.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const el = node as Element;
        if (el.shadowRoot) {
          allInputs.push(
            ...(Array.from(el.shadowRoot.querySelectorAll(selector)) as HTMLElement[]),
          );
        }
        node = walker.nextNode();
      }
    }

    let bestMatch: HTMLElement | null = null;
    let bestScore = 0;

    for (const el of allInputs) {
      if (!this.isValidTarget(el)) continue;

      const attrs = this.getInputAttrs(el);
      let score = 0;

      // Exact match on any attribute
      for (const attr of attrs) {
        if (attr === label) { score = 100; break; }
        if (attr.includes(label) || label.includes(attr)) {
          score = Math.max(score, 50);
        }
      }

      // Word overlap for partial matches
      if (score === 0 && label.length > 3) {
        const labelWords = label.split(/\s+/).filter(w => w.length > 2);
        for (const attr of attrs) {
          const matched = labelWords.filter(w => attr.includes(w)).length;
          if (matched > 0) {
            score = Math.max(score, (matched / labelWords.length) * 40);
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    return bestMatch;
  }

  private getInputAttrs(el: HTMLElement): string[] {
    const attrs: string[] = [];
    const add = (val: string | null | undefined) => {
      if (val?.trim()) attrs.push(val.trim().toLowerCase());
    };

    add(el.getAttribute("aria-label"));
    add(el.getAttribute("placeholder"));
    add(el.getAttribute("name"));
    add(el.id);

    // Resolve aria-labelledby — check shadow root first, then owner document
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const rootNode = el.getRootNode();
      const escapedId = CSS.escape(labelledBy);
      const labelEl =
        (rootNode as ShadowRoot | Document).querySelector?.(`#${escapedId}`) ??
        document.querySelector(`#${escapedId}`);
      add(labelEl?.textContent);
    }

    // Associated <label for="id">
    if (el.id) {
      const rootNode = el.getRootNode();
      const escapedId = CSS.escape(el.id);
      const labelEl =
        (rootNode as ShadowRoot | Document).querySelector?.(`label[for="${escapedId}"]`) ??
        document.querySelector(`label[for="${escapedId}"]`);
      add(labelEl?.textContent);
    }

    return attrs;
  }
  /**
   * Waterfall element-finding strategy.
   * Tries multiple strategies including Shadow DOM traversal for awsui-* components.
   */
  private findElementSafely(step: GuidanceStep): HTMLElement | null {
    const targetText = (step.targetText || "").trim();
    const targetSelector = (step.targetSelector || "").trim();

    if (targetText.startsWith("[input:") || targetText.startsWith("[textarea:") || targetText.startsWith("[dropdown:")) {
      const inputMatch = this.findInputElement(targetText);

      if (inputMatch) {
        this._lastFindStrategy = "input-match";
        console.log("[Highlighter] ✓ Found input element");
        return inputMatch;
      }
    }

    if (!targetText && !targetSelector) return null;

    // Strategy 0: Tag hint — deterministic match using tag + text from element list
    if (step.tagHint && targetText) {
      const el = this.findByTagAndText(step.tagHint, targetText, step.selectorHint);
      if (el) {
        this._lastFindStrategy = "tag-hint";
        console.log(`[Highlighter] ✓ Found via tag hint: <${step.tagHint}> "${targetText}"`);
        return el;
      }
    }

    // Strategy 1: Exact aria-label — main DOM then Shadow DOM
    if (targetText) {
      const el = this.findByAriaLabel(targetText, true);
      if (el) {
        this._lastFindStrategy = "exact-aria-label";
        console.log("[Highlighter] ✓ Found via exact aria-label");
        return el;
      }
      const shadow = this.searchShadowByAttribute(
        "aria-label",
        targetText,
        true,
      );
      if (shadow) {
        this._lastFindStrategy = "exact-aria-label-shadow";
        console.log("[Highlighter] ✓ Found via exact aria-label (shadow DOM)");
        return shadow;
      }
    }

    // Strategy 2: Exact collapsed-text match — main DOM then Shadow DOM
    if (targetText) {
      const el = this.findByExactText(targetText);
      if (el) {
        this._lastFindStrategy = "exact-text";
        console.log("[Highlighter] ✓ Found via exact text");
        return el;
      }
      const shadow = this.searchShadowByText(targetText, true);
      if (shadow) {
        this._lastFindStrategy = "exact-text-shadow";
        console.log("[Highlighter] ✓ Found via exact text (shadow DOM)");
        return shadow;
      }
    }

    // Strategy 3: data-analytics-metadata match
    if (targetText) {
      const el = this.findByDataAnalytics(targetText);
      if (el) {
        this._lastFindStrategy = "data-analytics";
        console.log("[Highlighter] ✓ Found via data-analytics-metadata");
        return el;
      }
    }

    // Strategy 4: Contains aria-label — main DOM then Shadow DOM
    if (targetText) {
      const el = this.findByAriaLabel(targetText, false);
      if (el) {
        this._lastFindStrategy = "contains-aria-label";
        console.log("[Highlighter] ✓ Found via contains aria-label");
        return el;
      }
      const shadow = this.searchShadowByAttribute(
        "aria-label",
        targetText,
        false,
      );
      if (shadow) {
        this._lastFindStrategy = "contains-aria-label-shadow";
        console.log(
          "[Highlighter] ✓ Found via contains aria-label (shadow DOM)",
        );
        return shadow;
      }
    }

    // Strategy 5: Contains text in Shadow DOM
    if (targetText) {
      const shadow = this.searchShadowByText(targetText, false);
      if (shadow) {
        this._lastFindStrategy = "contains-text-shadow";
        console.log("[Highlighter] ✓ Found via contains text (shadow DOM)");
        return shadow;
      }
    }

    // Strategy 6: Scored text match (handles whitespace, sidebar penalty)
    if (targetText) {
      const el = this.findBestElementForText(targetText);
      if (el) {
        this._lastFindStrategy = "scored-text";
        console.log("[Highlighter] ✓ Found via scored text match");
        return el;
      }
    }

    // Strategy 7: CSS selector fallback
    if (targetSelector) {
      const el = this.findByCSSSelector(targetSelector);
      if (el) {
        this._lastFindStrategy = "css-selector";
        console.log("[Highlighter] ✓ Found via CSS selector fallback");
        return el;
      }
    }

    // Strategy 8: Word-boundary matching
    if (targetText && targetText.length > 3) {
      const el = this.findByWordBoundary(targetText);
      if (el) {
        this._lastFindStrategy = "word-boundary";
        console.log("[Highlighter] ✓ Found via word-boundary match");
        return el;
      }
    }

    // Strategy 9: Fuzzy text matching (Levenshtein distance ≤ 3)
    if (targetText && targetText.length > 3) {
      const el = this.findByFuzzyText(targetText, 3);
      if (el) {
        this._lastFindStrategy = "fuzzy-text";
        console.log("[Highlighter] ✓ Found via fuzzy text match");
        return el;
      }
    }

    this._lastFindStrategy = "none";
    return null;
  }

  /* ========================================================================
     TAG + TEXT MATCH (Strategy 0 — deterministic, from element list lookup)
     ======================================================================== */

  private findByTagAndText(
    tagHint: string,
    targetText: string,
    selectorHint?: string,
  ): HTMLElement | null {
    const tag = tagHint.toLowerCase();
    const normalized = targetText.toLowerCase().trim();

    // First try the exact CSS selector from the element list
    if (selectorHint) {
      const el = this.findByCSSSelector(selectorHint);
      if (el && el.tagName.toLowerCase() === tag) {
        return el;
      }
    }

    // Search all roots (main doc + iframes) for elements of this tag
    const candidates: HTMLElement[] = [];

    for (const el of this.queryAllRoots(tag)) {
      if (!this.isValidTarget(el)) continue;

      const elText = (el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      // Also check aria-label
      const ariaLabel = (el.getAttribute("aria-label") || "")
        .trim()
        .toLowerCase();

      if (elText === normalized || ariaLabel === normalized) {
        candidates.push(el);
      }
    }

    // Also search shadow DOMs
    for (const root of this.getSearchRoots()) {
      const body = root.body;
      if (!body) continue;
      const walker = root.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const el = node as Element;
        if (el.shadowRoot) {
          for (const shadowEl of Array.from(el.shadowRoot.querySelectorAll(tag)) as HTMLElement[]) {
            if (!this.isValidTarget(shadowEl)) continue;
            const elText = (shadowEl.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            const ariaLabel = (shadowEl.getAttribute("aria-label") || "")
              .trim()
              .toLowerCase();
            if (elText === normalized || ariaLabel === normalized) {
              candidates.push(shadowEl);
            }
          }
        }
        node = walker.nextNode();
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    // Multiple same-tag matches — use scoring to disambiguate
    return this.pickBestCandidate(candidates, normalized);
  }

  /* ========================================================================
     SHADOW DOM TRAVERSAL (for awsui-* web components)
     AWS Console embeds most buttons/links in shadow roots — standard
     querySelectorAll() cannot see them at all.
     ======================================================================== */

  /**
   * Search all shadow roots on the page for an element matching an attribute.
   */
  private searchShadowByAttribute(
    attribute: string,
    value: string,
    exact: boolean,
  ): HTMLElement | null {
    const normalized = value.toLowerCase().trim();

    const searchRoot = (root: Document | ShadowRoot): HTMLElement | null => {
      const elements = root.querySelectorAll(`[${attribute}]`);
      for (const el of Array.from(elements)) {
        const htmlEl = el as HTMLElement;
        const attrVal = (htmlEl.getAttribute(attribute) || "")
          .toLowerCase()
          .trim();
        const matches = exact
          ? attrVal === normalized
          : attrVal.includes(normalized) || normalized.includes(attrVal);
        if (
          matches &&
          this.isValidTarget(htmlEl) &&
          !this.isInSideNav(htmlEl)
        ) {
          return htmlEl;
        }
      }
      return null;
    };

    for (const root of this.getSearchRoots()) {
      const body = root.body;
      if (!body) continue;
      const walker = root.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const el = node as Element;
        if (el.shadowRoot) {
          const found = searchRoot(el.shadowRoot);
          if (found) return found;
        }
        node = walker.nextNode();
      }
    }
    return null;
  }

  /**
   * Search all shadow roots for an element with matching text content.
   */
  private searchShadowByText(text: string, exact: boolean): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const selectors = [
      "button",
      "a",
      'div[role="button"]',
      'span[role="button"]',
      "awsui-button",
      "awsui-link",
    ];

    const searchRoot = (root: Document | ShadowRoot): HTMLElement | null => {
      for (const selector of selectors) {
        const elements = root.querySelectorAll(selector);
        for (const el of Array.from(elements)) {
          const htmlEl = el as HTMLElement;
          if (!this.isValidTarget(htmlEl)) continue;
          const elText = (htmlEl.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          const matches = exact
            ? elText === normalized
            : elText.includes(normalized);
          if (matches && !this.isInSideNav(htmlEl)) return htmlEl;
        }
      }
      return null;
    };

    for (const root of this.getSearchRoots()) {
      const body = root.body;
      if (!body) continue;
      const walker = root.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        const el = node as Element;
        if (el.shadowRoot) {
          const found = searchRoot(el.shadowRoot);
          if (found) return found;
        }
        node = walker.nextNode();
      }
    }
    return null;
  }

  /**
   * Exact collapsed-text search in the main DOM.
   * Collapses all whitespace (AWS wraps button text in many nested spans).
   */
  private findByExactText(text: string): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const selectors = [
      "button",
      "a",
      'div[role="button"]',
      'span[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
    ];

    const candidates: HTMLElement[] = [];

    for (const selector of selectors) {
      for (const el of this.queryAllRoots(selector)) {
        if (!this.isValidTarget(el)) continue;
        const elText = (el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (elText === normalized) {
          candidates.push(el);
        }
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;

    // Multiple matches — score to pick the most specific one
    return this.pickBestCandidate(candidates, normalized);
  }

  private pickBestCandidate(candidates: HTMLElement[], targetText: string): HTMLElement {
    let best = candidates[0]!;
    let bestScore = -Infinity;

    for (const el of candidates) {
      let score = 0;

      // Prefer elements with fewer children (leaf-like = more specific)
      const childCount = el.querySelectorAll("*").length;
      score -= childCount * 5;

      // Prefer smaller elements (link-sized, not containers)
      const rect = this.getAbsoluteRect(el);
      if (rect.width > 0 && rect.width < 300 && rect.height > 0 && rect.height < 80) {
        score += 30;
      }

      // Prefer elements in the viewport
      if (rect.top >= 0 && rect.top < window.innerHeight) {
        score += 20;
      }

      // Prefer <a> and <button> tags
      const tag = el.tagName.toLowerCase();
      if (tag === "a") score += 15;
      if (tag === "button") score += 15;

      // Penalize sidebar
      if (this.isInSideNav(el)) score -= 40;

      // Prefer elements whose text is closest in length to target (most specific)
      const textLen = (el.textContent || "").trim().length;
      score -= Math.abs(textLen - targetText.length) * 2;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  /**
   * Find by aria-label attribute (main DOM, sidebar-aware).
   */
  private findByAriaLabel(text: string, exact: boolean): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const allElements = this.queryAllRoots("[aria-label]");
    const candidates: HTMLElement[] = [];

    for (const el of Array.from(allElements)) {
      const label = (el.getAttribute("aria-label") || "")
        .toLowerCase()
        .trim();

      const matches = exact
        ? label === normalized
        : label.includes(normalized) || normalized.includes(label);

      if (matches && this.isValidTarget(el)) {
        candidates.push(el);
      }
    }

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!;
    return this.pickBestCandidate(candidates, normalized);
  }

  /**
   * Find by data-analytics-metadata attribute.
   */
  private findByDataAnalytics(text: string): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const allElements = this.queryAllRoots("[data-analytics-metadata]");

    for (const el of Array.from(allElements)) {
      const htmlEl = el as HTMLElement;
      const metadata = (htmlEl.getAttribute("data-analytics-metadata") || "")
        .toLowerCase()
        .trim();

      if (metadata.includes(normalized) && this.isValidTarget(htmlEl)) {
        return htmlEl;
      }
    }
    return null;
  }
  private findBestElementForText(text: string): HTMLElement | null {
    const normalized = text.toLowerCase().trim();

    /**
     * Get the clean, collapsed text label of an element.
     * AWS wraps button text in nested <span>s with lots of whitespace —
     * we need to collapse that to a single trimmed string.
     */
    const cleanText = (el: HTMLElement): string => {
      // Prefer aria-label as the most authoritative identifier
      const aria = (el.getAttribute("aria-label") || "").trim();
      if (aria) return aria.toLowerCase();
      // Collapse all nested text content (whitespace-normalised)
      return (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    };

    interface Candidate {
      el: HTMLElement;
      score: number;
    }
    const candidates: Candidate[] = [];

    const allInteractive = this.queryAllRoots(
      'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
    );

    for (const el of Array.from(allInteractive)) {
      const htmlEl = el as HTMLElement;
      if (!this.isValidTarget(htmlEl)) continue;

      const label = cleanText(htmlEl);

      // Must contain the target text, or target text must contain label
      const hasExact = label === normalized;
      const hasContains = label.includes(normalized);
      const targetInLabel = normalized.includes(label) && label.length > 2;

      if (!hasExact && !hasContains && !targetInLabel) continue;

      // Reject if text is way longer than target AND it's not an exact match
      // (8x allows for buttons with badges like "Instances (12)")
      if (!hasExact && label.length > normalized.length * 8) continue;

      let score = 0;

      if (hasExact) score += 100;
      else if (hasContains) score += 50;
      else if (targetInLabel) score += 30;

      // aria-label match is more reliable than text match
      if (el.getAttribute("aria-label")) {
        const ariaLower = el.getAttribute("aria-label")!.toLowerCase();
        if (ariaLower === normalized) score += 60;
        else if (ariaLower.includes(normalized)) score += 30;
      }

      // Prefer real interactive elements
      const tag = htmlEl.tagName.toLowerCase();
      if (tag === "button") score += 30;
      if (tag === "a") score += 15;
      const role = htmlEl.getAttribute("role") || "";
      if (role === "button") score += 25;
      if (role === "tab") score += 15;

      // Shorter text = more specific (not a container with lots of nested text)
      const lengthPenalty = Math.max(0, label.length - normalized.length);
      score -= Math.min(50, lengthPenalty * 2);

      // Penalise containers that have interactive children inside them
      const interactiveChildren = htmlEl.querySelectorAll(
        'button, a, input, [role="button"]',
      ).length;
      score -= interactiveChildren * 20;

      // Prefer main content over sidebar
      if (!this.isInSideNav(htmlEl)) score += 20;
      // Extra penalty for sidebar elements when main-content match exists
      if (this.isInSideNav(htmlEl)) score -= 40;

      candidates.push({ el: htmlEl, score });
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);
    console.log(
      "[Highlighter] Scored candidates for",
      JSON.stringify(text),
      ":",
      candidates.slice(0, 5).map((c) => ({
        label: cleanText(c.el).substring(0, 40),
        tag: c.el.tagName,
        score: c.score,
      })),
    );

    return candidates[0]!.el;
  }

  /**
   * Try a CSS selector directly.
   */
  private findByCSSSelector(selector: string): HTMLElement | null {
    for (const root of this.getSearchRoots()) {
      try {
        const el = root.querySelector(selector) as HTMLElement | null;
        if (el && this.isValidTarget(el)) {
          return el;
        }
      } catch {
        // Invalid CSS selector, skip
      }
    }
    return null;
  }

  /**
   * Find by matching individual significant words from the target text.
   * E.g. "Launch instances" matches an element with text "Launch instance"
   * if enough key words overlap.
   */
  private findByWordBoundary(text: string): HTMLElement | null {
    const words = text
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return null;

    const interactiveSelectors = [
      "button",
      "a",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
    ];

    let bestMatch: HTMLElement | null = null;
    let bestScore = 0;

    for (const selector of interactiveSelectors) {
      for (const el of this.queryAllRoots(selector)) {
        if (!this.isValidTarget(el)) continue;

        const elText = (el.textContent || "").toLowerCase().trim();
        if (!elText || elText.length > 100) continue;

        let matchCount = 0;
        for (const word of words) {
          if (elText.includes(word)) matchCount++;
        }

        const score = matchCount / words.length;
        if (score >= 0.6 && score > bestScore) {
          bestScore = score;
          bestMatch = el;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Fuzzy text matching using Levenshtein distance.
   * Finds the interactive element whose text is closest to the target,
   * within the specified max distance.
   */
  private findByFuzzyText(
    text: string,
    maxDistance: number,
  ): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    if (normalized.length < 3) return null;

    const interactiveSelectors = [
      "button",
      "a",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
    ];

    let bestMatch: HTMLElement | null = null;
    let bestDistance = maxDistance + 1;

    for (const selector of interactiveSelectors) {
      for (const el of this.queryAllRoots(selector)) {
        if (!this.isValidTarget(el)) continue;

        const elText = (el.textContent || "").trim().toLowerCase();
        if (!elText || elText.length > 80) continue;

        if (Math.abs(elText.length - normalized.length) > maxDistance) continue;

        const dist = this.levenshteinDistance(normalized, elText);
        if (dist <= maxDistance && dist < bestDistance) {
          bestDistance = dist;
          bestMatch = el;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Compute Levenshtein distance between two strings.
   * Capped for performance — returns maxVal+1 early if distance exceeds cap.
   */
  private levenshteinDistance(a: string, b: string, maxVal = 5): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Quick length check
    if (Math.abs(a.length - b.length) > maxVal) return maxVal + 1;

    const matrix: number[][] = [];

    for (let i = 0; i <= a.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
      matrix[0]![j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1, // deletion
          matrix[i]![j - 1]! + 1, // insertion
          matrix[i - 1]![j - 1]! + cost, // substitution
        );
        rowMin = Math.min(rowMin, matrix[i]![j]!);
      }
      // Early termination if entire row exceeds max
      if (rowMin > maxVal) return maxVal + 1;
    }

    return matrix[a.length]![b.length]!;
  }

  /* ========================================================================
     SCROLL — Smart scroll handling for elements in containers
     ======================================================================== */

  /**
   * Scroll to an element, handling nested scrollable containers.
   */
  private async scrollToElement(el: HTMLElement): Promise<void> {
    // First, scroll any scrollable parent containers
    let current: HTMLElement | null = el.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const isScrollable =
        (style.overflow === "auto" ||
          style.overflow === "scroll" ||
          style.overflowY === "auto" ||
          style.overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight;

      if (isScrollable) {
        // Scroll this container so the element is visible
        const containerRect = current.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();

        if (
          elRect.bottom > containerRect.bottom ||
          elRect.top < containerRect.top
        ) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      current = current.parentElement;
    }

    // Then scroll the main viewport
    el.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center",
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  /* ========================================================================
     VALIDATION
     ======================================================================== */

  private isValidTarget(el: HTMLElement): boolean {
    if (!el || !el.isConnected) return false;
    if (this.isOwnUI(el)) return false;
    if (!this.isVisible(el)) return false;
    if (
      el.hasAttribute("disabled") ||
      el.getAttribute("aria-disabled") === "true"
    ) {
      return false;
    }
    // Don't highlight navigation utility controls
    const label = (el.getAttribute("aria-label") || el.textContent || "")
      .toLowerCase()
      .trim();
    if (
      /^(open|close|toggle|expand|collapse)\s+(navigation|nav|sidebar|drawer|menu)/i.test(
        label,
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * Check if element is inside a nav/sidebar container.
   * Used to prefer main-content matches over sidebar matches.
   */
  private isInSideNav(el: HTMLElement): boolean {
    let current: HTMLElement | null = el.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 12) {
      const tag = current.tagName.toLowerCase();
      const role = current.getAttribute("role") || "";
      const id = (current.id || "").toLowerCase();
      const cls = (typeof current.className === "string" ? current.className : "").toLowerCase();
      if (
        tag === "nav" ||
        tag === "aside" ||
        role === "navigation" ||
        id.includes("sidebar") ||
        id.includes("side-nav") ||
        cls.includes("sidebar") ||
        cls.includes("side-nav")
      ) {
        return true;
      }
      current = current.parentElement;
      depth++;
    }
    return false;
  }

  private isOwnUI(el: HTMLElement): boolean {
    let current: HTMLElement | null = el;
    while (current) {
      if (
        current.id === "aws-nav-assistant-root" ||
        current.classList.contains("aws-nav-assistant") ||
        current.classList.contains("aws-nav-highlight-container") ||
        current.classList.contains("aws-nav-highlight-box") ||
        current.classList.contains("aws-nav-highlight-label")
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  private isVisible(el: HTMLElement): boolean {
    try {
      const style = window.getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        (el.offsetWidth > 0 ||
          el.offsetHeight > 0 ||
          el.getClientRects().length > 0)
      );
    } catch {
      return false;
    }
  }

  /* ========================================================================
     SPOTLIGHT OVERLAY (kept from original — it looks great)
     ======================================================================== */

  private renderOverlay(el: HTMLElement, text: string): void {
    const overlay = document.createElement("div");
    overlay.className = "aws-nav-highlight-container";
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2147483647;
      pointer-events: none;
      background: transparent;
    `;

    // Spotlight cutout box
    const box = document.createElement("div");
    box.className = "aws-nav-highlight-box";
    box.style.cssText = `
      position: fixed;
      border: 4px solid #00D9FF;
      border-radius: 8px;
      background: rgba(0, 217, 255, 0.1);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6),
                  0 0 30px rgba(0, 217, 255, 0.8),
                  inset 0 0 20px rgba(0, 217, 255, 0.3);
      pointer-events: none;
      transition: all 0.2s ease;
      z-index: 2147483647;
      animation: aws-nav-pulse-highlight 2s ease-in-out infinite;
    `;

    // Instruction tooltip
    const label = document.createElement("div");
    label.className = "aws-nav-highlight-label";
    label.textContent = text;
    label.style.cssText = `
      position: fixed;
      background: linear-gradient(135deg, #00D9FF 0%, #00A3CC 100%);
      color: #0A0E27;
      padding: 10px 16px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      max-width: 300px;
      z-index: 2147483647;
      pointer-events: none;
      white-space: pre-wrap;
    `;

    // Arrow indicator
    const arrow = document.createElement("div");
    arrow.className = "aws-nav-highlight-arrow";
    arrow.style.cssText = `
      position: fixed;
      width: 0; height: 0;
      border-left: 8px solid transparent;
      border-right: 8px solid transparent;
      border-top: 8px solid #00D9FF;
      z-index: 2147483647;
      pointer-events: none;
    `;

    this.addPulseAnimation();

    // Position update function
    const update = () => {
      if (!el.isConnected) {
        this.clearHighlights();
        return;
      }

      const rect = this.getAbsoluteRect(el);
      const padding = 8;

      // Box position
      box.style.top = `${rect.top - padding}px`;
      box.style.left = `${rect.left - padding}px`;
      box.style.width = `${rect.width + padding * 2}px`;
      box.style.height = `${rect.height + padding * 2}px`;

      // Smart label positioning
      const labelHeight = 40;
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;

      if (spaceAbove > labelHeight + 20) {
        // Place above
        label.style.top = `${rect.top - labelHeight - 15}px`;
        label.style.left = `${Math.max(10, rect.left)}px`;
        arrow.style.top = `${rect.top - 15}px`;
        arrow.style.left = `${rect.left + rect.width / 2 - 8}px`;
        arrow.style.borderTop = "8px solid #00D9FF";
        arrow.style.borderBottom = "none";
      } else if (spaceBelow > labelHeight + 20) {
        // Place below
        label.style.top = `${rect.bottom + 15}px`;
        label.style.left = `${Math.max(10, rect.left)}px`;
        arrow.style.top = `${rect.bottom + 7}px`;
        arrow.style.left = `${rect.left + rect.width / 2 - 8}px`;
        arrow.style.borderBottom = "8px solid #00D9FF";
        arrow.style.borderTop = "none";
      } else {
        // Place to the right
        label.style.top = `${rect.top}px`;
        label.style.left = `${rect.right + 15}px`;
        arrow.style.display = "none";
      }
    };

    update();

    // Observe position changes
    this.resizeObserver = new ResizeObserver(update);
    this.resizeObserver.observe(el);
    this.resizeObserver.observe(document.body);

    const scrollHandler = () => update();
    window.addEventListener("scroll", scrollHandler, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", scrollHandler, { passive: true });
    this.scrollListeners.push(() => {
      window.removeEventListener("scroll", scrollHandler, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("resize", scrollHandler);
    });

    // If element is in an iframe, also listen for scroll/resize inside it
    const elWindow = el.ownerDocument.defaultView;
    if (elWindow && elWindow !== window) {
      elWindow.addEventListener("scroll", scrollHandler, { capture: true, passive: true });
      elWindow.addEventListener("resize", scrollHandler, { passive: true });
      this.scrollListeners.push(() => {
        elWindow.removeEventListener("scroll", scrollHandler, { capture: true } as EventListenerOptions);
        elWindow.removeEventListener("resize", scrollHandler);
      });
    }

    overlay.appendChild(box);
    overlay.appendChild(arrow);
    overlay.appendChild(label);
    document.body.appendChild(overlay);

    this.overlay = overlay;
  }

  private addPulseAnimation(): void {
    if (document.getElementById("aws-nav-pulse-animation")) return;

    const style = document.createElement("style");
    style.id = "aws-nav-pulse-animation";
    style.textContent = `
      @keyframes aws-nav-pulse-highlight {
        0%, 100% {
          border-color: #00D9FF;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6),
                      0 0 30px rgba(0, 217, 255, 0.8),
                      inset 0 0 20px rgba(0, 217, 255, 0.3);
        }
        50% {
          border-color: #00F0FF;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6),
                      0 0 50px rgba(0, 217, 255, 1),
                      inset 0 0 30px rgba(0, 217, 255, 0.5);
        }
      }
    `;
    document.head.appendChild(style);
  }
}

export const highlighter = new ElementHighlighter();
