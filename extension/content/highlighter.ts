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
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;
  private currentTargetElement: HTMLElement | null = null;

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
      console.error("[Highlighter] ❌ Element not found after all strategies");
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
   * - onOtherClick: called when user clicks somewhere else (not extension UI)
   */
  attachClickDetection(
    el: HTMLElement,
    onTargetClick: () => void,
    onOtherClick: () => void
  ): void {
    // Clean up any previous handlers
    this.detachClickDetection();

    // Target element click (capture phase to catch before AWS prevents propagation)
    this.targetClickHandler = () => {
      console.log("[Highlighter] ✓ Target element clicked");
      this.clearHighlights();
      onTargetClick();
    };
    el.addEventListener("click", this.targetClickHandler, {
      once: true,
      capture: true,
    });

    // Document-level click to detect "other" clicks
    this.documentClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Ignore clicks on our own UI (overlay, extension panel)
      if (this.isOwnUI(target)) return;

      // Ignore clicks on the highlighted element (handled above)
      if (el.contains(target) || target === el) return;

      console.log("[Highlighter] ⚠ Click on non-target element");
      this.clearHighlights();
      onOtherClick();
    };

    // Use a small delay so the document handler doesn't fire on the same click that opened guidance
    setTimeout(() => {
      if (this.documentClickHandler) {
        document.addEventListener("click", this.documentClickHandler, {
          capture: true,
        });
      }
    }, 100);
  }

  /**
   * Remove click detection handlers.
   */
  detachClickDetection(): void {
    if (this.targetClickHandler && this.currentTargetElement) {
      this.currentTargetElement.removeEventListener(
        "click",
        this.targetClickHandler,
        { capture: true } as EventListenerOptions
      );
    }
    if (this.documentClickHandler) {
      document.removeEventListener("click", this.documentClickHandler, {
        capture: true,
      } as EventListenerOptions);
    }
    this.targetClickHandler = null;
    this.documentClickHandler = null;
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
    delayMs: number
  ): Promise<HTMLElement | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const el = this.findElementSafely(step);
      if (el) {
        console.log(
          `[Highlighter] Found on attempt ${attempt}/${maxRetries}`
        );
        return el;
      }

      if (attempt < maxRetries) {
        console.log(`[Highlighter] Retry ${attempt}/${maxRetries}...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return null;
  }

  /**
   * Waterfall element-finding strategy.
   * Tries multiple strategies in order of reliability.
   */
  private findElementSafely(step: GuidanceStep): HTMLElement | null {
    const targetText = (step.targetText || "").trim();
    const targetSelector = (step.targetSelector || "").trim();

    // Strategy 1: Exact aria-label match
    if (targetText) {
      const el = this.findByAriaLabel(targetText, true);
      if (el) {
        this._lastFindStrategy = "exact-aria-label";
        console.log("[Highlighter] ✓ Found via exact aria-label");
        return el;
      }
    }

    // Strategy 2: Contains aria-label match
    if (targetText) {
      const el = this.findByAriaLabel(targetText, false);
      if (el) {
        this._lastFindStrategy = "contains-aria-label";
        console.log("[Highlighter] ✓ Found via contains aria-label");
        return el;
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

    // Strategy 4: Exact visible text match (case-insensitive)
    if (targetText) {
      const el = this.findByVisibleText(targetText, true);
      if (el) {
        this._lastFindStrategy = "exact-text";
        console.log("[Highlighter] ✓ Found via exact text match");
        return el;
      }
    }

    // Strategy 5: Contains visible text match
    if (targetText) {
      const el = this.findByVisibleText(targetText, false);
      if (el) {
        this._lastFindStrategy = "contains-text";
        console.log("[Highlighter] ✓ Found via contains text match");
        return el;
      }
    }

    // Strategy 6: Try targetSelector as-is (CSS selector fallback)
    if (targetSelector) {
      const el = this.findByCSSSelector(targetSelector);
      if (el) {
        this._lastFindStrategy = "css-selector";
        console.log("[Highlighter] ✓ Found via CSS selector fallback");
        return el;
      }
    }

    // Strategy 7: Word-boundary matching (match individual key words)
    if (targetText && targetText.length > 3) {
      const el = this.findByWordBoundary(targetText);
      if (el) {
        this._lastFindStrategy = "word-boundary";
        console.log("[Highlighter] ✓ Found via word-boundary match");
        return el;
      }
    }

    // Strategy 8: Fuzzy text matching (Levenshtein distance ≤ 3)
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

  /**
   * Find by aria-label attribute.
   */
  private findByAriaLabel(
    text: string,
    exact: boolean
  ): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const allElements = document.querySelectorAll("[aria-label]");

    for (const el of Array.from(allElements)) {
      const htmlEl = el as HTMLElement;
      const label = (htmlEl.getAttribute("aria-label") || "")
        .toLowerCase()
        .trim();

      const matches = exact
        ? label === normalized
        : label.includes(normalized) || normalized.includes(label);

      if (matches && this.isValidTarget(htmlEl)) {
        return htmlEl;
      }
    }
    return null;
  }

  /**
   * Find by data-analytics-metadata attribute.
   */
  private findByDataAnalytics(text: string): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    const allElements = document.querySelectorAll(
      "[data-analytics-metadata]"
    );

    for (const el of Array.from(allElements)) {
      const htmlEl = el as HTMLElement;
      const metadata = (
        htmlEl.getAttribute("data-analytics-metadata") || ""
      )
        .toLowerCase()
        .trim();

      if (metadata.includes(normalized) && this.isValidTarget(htmlEl)) {
        return htmlEl;
      }
    }
    return null;
  }

  /**
   * Find by visible text content.
   */
  private findByVisibleText(
    text: string,
    exact: boolean
  ): HTMLElement | null {
    const normalized = text.toLowerCase().trim();

    // Search interactive elements first, then all visible elements
    const selectors = [
      "button",
      "a",
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      "input[type='submit']",
      "span",
      "div",
    ];

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        const htmlEl = el as HTMLElement;
        const elText = (htmlEl.textContent || "").trim().toLowerCase();

        // For exact: text must match completely
        // For contains: either side can contain the other
        const matches = exact
          ? elText === normalized
          : elText.includes(normalized) ||
            (normalized.length > 3 && normalized.includes(elText) && elText.length > 2);

        if (matches && this.isValidTarget(htmlEl)) {
          // Prefer the most specific (deepest) matching element
          // Find the deepest child that still contains the text
          const deepest = this.findDeepestMatch(htmlEl, normalized, exact);
          return deepest || htmlEl;
        }
      }
    }

    return null;
  }

  /**
   * Find the deepest child element that matches the target text.
   * This avoids highlighting a giant container when a specific button matches.
   */
  private findDeepestMatch(
    parent: HTMLElement,
    normalizedText: string,
    exact: boolean
  ): HTMLElement | null {
    const children = parent.querySelectorAll("button, a, span, [role='button']");
    for (const child of Array.from(children)) {
      const htmlChild = child as HTMLElement;
      const childText = (htmlChild.textContent || "").trim().toLowerCase();

      const matches = exact
        ? childText === normalizedText
        : childText.includes(normalizedText);

      if (matches && this.isValidTarget(htmlChild)) {
        return htmlChild;
      }
    }
    return null;
  }

  /**
   * Try a CSS selector directly.
   */
  private findByCSSSelector(selector: string): HTMLElement | null {
    try {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el && this.isValidTarget(el)) {
        return el;
      }
    } catch {
      // Invalid CSS selector, skip
    }
    return null;
  }

  /**
   * Find by matching individual significant words from the target text.
   * E.g. "Launch instances" matches an element with text "Launch instance"
   * if enough key words overlap.
   */
  private findByWordBoundary(text: string): HTMLElement | null {
    const words = text.toLowerCase().trim().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) return null;

    const interactiveSelectors = [
      "button", "a", '[role="button"]', '[role="link"]',
      '[role="tab"]', '[role="menuitem"]',
    ];

    let bestMatch: HTMLElement | null = null;
    let bestScore = 0;

    for (const selector of interactiveSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        const htmlEl = el as HTMLElement;
        if (!this.isValidTarget(htmlEl)) continue;

        const elText = (htmlEl.textContent || "").toLowerCase().trim();
        if (!elText || elText.length > 100) continue;

        // Count how many target words appear in the element text
        let matchCount = 0;
        for (const word of words) {
          if (elText.includes(word)) matchCount++;
        }

        // Require at least 60% of words to match
        const score = matchCount / words.length;
        if (score >= 0.6 && score > bestScore) {
          bestScore = score;
          bestMatch = htmlEl;
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
  private findByFuzzyText(text: string, maxDistance: number): HTMLElement | null {
    const normalized = text.toLowerCase().trim();
    if (normalized.length < 3) return null;

    const interactiveSelectors = [
      "button", "a", '[role="button"]', '[role="link"]',
      '[role="tab"]', '[role="menuitem"]',
    ];

    let bestMatch: HTMLElement | null = null;
    let bestDistance = maxDistance + 1;

    for (const selector of interactiveSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        const htmlEl = el as HTMLElement;
        if (!this.isValidTarget(htmlEl)) continue;

        const elText = (htmlEl.textContent || "").trim().toLowerCase();
        if (!elText || elText.length > 80) continue;

        // Skip if length difference is too large (quick pre-filter)
        if (Math.abs(elText.length - normalized.length) > maxDistance) continue;

        const dist = this.levenshteinDistance(normalized, elText);
        if (dist <= maxDistance && dist < bestDistance) {
          bestDistance = dist;
          bestMatch = htmlEl;
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
          matrix[i - 1]![j]! + 1,        // deletion
          matrix[i]![j - 1]! + 1,        // insertion
          matrix[i - 1]![j - 1]! + cost  // substitution
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
        (style.overflow === "auto" || style.overflow === "scroll" ||
         style.overflowY === "auto" || style.overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight;

      if (isScrollable) {
        // Scroll this container so the element is visible
        const containerRect = current.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();

        if (elRect.bottom > containerRect.bottom || elRect.top < containerRect.top) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      current = current.parentElement;
    }

    // Then scroll the main viewport
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
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
    return true;
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

      const rect = el.getBoundingClientRect();
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
      window.removeEventListener("scroll", scrollHandler, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", scrollHandler);
    });

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