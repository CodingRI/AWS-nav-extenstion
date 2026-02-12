import type { NavigationStep } from "@aws-nav/shared";

export class ElementHighlighter {
  private overlay: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cleanupTimer: any = null;

  async highlightElement(step: NavigationStep): Promise<boolean> {
    this.clearHighlights();

    console.log(`[Highlighter] 🔍 Searching for: "${step.instruction}"`);
    console.log(`[Highlighter] Primary selector: ${step.selector}`);

    // Find element with strict priority matching
    const el = await this.findElementStrict(step);

    if (!el) {
      console.error(`[Highlighter] ❌ Element not found after all strategies`);
      return false;
    }

    console.log("[Highlighter] ✅ Found element:", el);
    console.log("[Highlighter] Element details:", {
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 50),
      ariaLabel: el.getAttribute('aria-label'),
      testId: el.getAttribute('data-testid')
    });

    // Scroll into view
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

    // Wait for scroll to complete
    await new Promise(r => setTimeout(r, 500));

    // Render overlay
    this.renderOverlay(el, step.instruction);

    // Bind click
    this.bindClick(el, step);

    return true;
  }

  async rehighlightCurrentStep(step: NavigationStep) {
    return this.highlightElement(step);
  }

  clearHighlights() {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
    }
  }

  /* ========================================================================
     STRICT PRIORITY-BASED ELEMENT FINDING
     ======================================================================== */

  /**
   * Find element with STRICT priority order and retries
   */
  private async findElementStrict(step: NavigationStep): Promise<HTMLElement | null> {
    const maxRetries = 20; // 10 seconds
    let attempts = 0;

    while (attempts < maxRetries) {
      attempts++;

      // PRIORITY 1: Try primary selector (CSS selector)
      let element = this.queryDeepStrict(step.selector);
      if (element) {
        console.log(`[Highlighter] ✓ Found via primary selector (attempt ${attempts})`);
        return element;
      }

      // PRIORITY 2: Try alternative selectors
      if (step.alternativeSelectors && step.alternativeSelectors.length > 0) {
        for (const altSelector of step.alternativeSelectors) {
          element = this.queryDeepStrict(altSelector);
          if (element) {
            console.log(`[Highlighter] ✓ Found via alternative selector: ${altSelector} (attempt ${attempts})`);
            return element;
          }
        }
      }

      // PRIORITY 3: Try aria-label match (STRICT, EXACT)
      if (step.textContent) {
        element = this.findByAriaLabelStrict(step.textContent);
        if (element) {
          console.log(`[Highlighter] ✓ Found via aria-label (attempt ${attempts})`);
          return element;
        }
      }

      // PRIORITY 4: Try data-testid match (STRICT, EXACT)
      if (step.textContent) {
        element = this.findByTestIdStrict(step.textContent);
        if (element) {
          console.log(`[Highlighter] ✓ Found via data-testid (attempt ${attempts})`);
          return element;
        }
      }

      // PRIORITY 5: Try exact text content match (STRICT, NO PARTIALS)
      if (step.textContent) {
        element = this.findByTextStrict(step.textContent);
        if (element) {
          console.log(`[Highlighter] ✓ Found via exact text (attempt ${attempts})`);
          return element;
        }
      }

      // Retry delay
      console.log(`[Highlighter] Retry ${attempts}/${maxRetries}...`);
      await new Promise(r => setTimeout(r, 500));
    }

    return null;
  }

  /* ========================================================================
     DEEP QUERY (Penetrates Shadow DOM) with STRICT RULES
     ======================================================================== */

  /**
   * Query with Shadow DOM support + STRICT visibility + ignore own UI
   */
  private queryDeepStrict(selector: string): HTMLElement | null {
    try {
      // 1. Try standard DOM first
      const standardElements = document.querySelectorAll(selector);
      for (const el of Array.from(standardElements)) {
        const htmlEl = el as HTMLElement;
        if (this.isValidTarget(htmlEl)) {
          return htmlEl;
        }
      }

      // 2. Search Shadow DOM
      return this.searchShadowDomStrict(selector);
    } catch (e) {
      console.warn(`[Highlighter] Invalid selector: ${selector}`, e);
      return null;
    }
  }

  /**
   * Traverse Shadow DOM - OPTIMIZED
   */
  private searchShadowDomStrict(selector: string): HTMLElement | null {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node: any) => {
          // Only traverse nodes that have shadowRoot
          return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const shadowRoot = (currentNode as Element).shadowRoot;
      if (shadowRoot) {
        try {
          const match = shadowRoot.querySelector(selector) as HTMLElement | null;
          if (match && this.isValidTarget(match)) {
            return match;
          }
        } catch (e) {
          // Invalid selector for this shadow root, skip
        }
      }
      currentNode = walker.nextNode();
    }

    return null;
  }

  /* ========================================================================
     STRICT ATTRIBUTE MATCHING (EXACT, NO FUZZY)
     ======================================================================== */

  /**
   * Find by aria-label - EXACT MATCH ONLY
   */
  private findByAriaLabelStrict(text: string): HTMLElement | null {
    const normalized = text.trim();

    // Search main DOM
    let found = this.searchByAttribute(document, 'aria-label', normalized);
    if (found) return found;

    // Search Shadow DOM
    return this.searchShadowDomByAttribute('aria-label', normalized);
  }

  /**
   * Find by data-testid - EXACT MATCH ONLY
   */
  private findByTestIdStrict(text: string): HTMLElement | null {
    const normalized = text.trim().toLowerCase();

    // Search main DOM
    let found = this.searchByAttribute(document, 'data-testid', normalized);
    if (found) return found;

    // Search Shadow DOM
    return this.searchShadowDomByAttribute('data-testid', normalized);
  }

  /**
   * Find by text content - EXACT MATCH ONLY (NO PARTIALS!)
   */
  private findByTextStrict(text: string): HTMLElement | null {
    const normalized = text.trim().toLowerCase();

    // ONLY search these specific interactive elements (AWS common patterns)
    const selectors = [
      'button',
      'a',
      'div[role="button"]',
      'span[role="button"]',
      'awsui-button'  // AWS UI Kit component
    ];

    // Search main DOM
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of Array.from(elements)) {
        const htmlEl = el as HTMLElement;
        const elText = (htmlEl.textContent || '').trim().toLowerCase();
        
        // STRICT: Must be EXACT match AND valid target
        if (elText === normalized && this.isValidTarget(htmlEl)) {
          return htmlEl;
        }
      }
    }

    // Search Shadow DOM
    return this.searchShadowDomByText(normalized, selectors);
  }

  /* ========================================================================
     HELPER: SEARCH WITHIN A ROOT
     ======================================================================== */

  /**
   * Search by attribute in a specific root (Document or ShadowRoot)
   */
  private searchByAttribute(
    root: Document | ShadowRoot,
    attribute: string,
    value: string
  ): HTMLElement | null {
    const selector = `[${attribute}]`;
    const elements = root.querySelectorAll(selector);
    
    for (const el of Array.from(elements)) {
      const htmlEl = el as HTMLElement;
      const attrValue = (htmlEl.getAttribute(attribute) || '').trim().toLowerCase();
      const searchValue = value.toLowerCase();
      
      // EXACT or CONTAINS match for aria-label, EXACT for data-testid
      const matches = attribute === 'aria-label' 
        ? attrValue === searchValue || attrValue.includes(searchValue)
        : attrValue === searchValue;
      
      if (matches && this.isValidTarget(htmlEl)) {
        return htmlEl;
      }
    }
    
    return null;
  }

  /**
   * Search Shadow DOM by attribute
   */
  private searchShadowDomByAttribute(attribute: string, value: string): HTMLElement | null {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node: any) => {
          return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const shadowRoot = (currentNode as Element).shadowRoot;
      if (shadowRoot) {
        const found = this.searchByAttribute(shadowRoot, attribute, value);
        if (found) return found;
      }
      currentNode = walker.nextNode();
    }

    return null;
  }

  /**
   * Search Shadow DOM by text
   */
  private searchShadowDomByText(text: string, selectors: string[]): HTMLElement | null {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node: any) => {
          return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      }
    );

    let currentNode = walker.nextNode();
    while (currentNode) {
      const shadowRoot = (currentNode as Element).shadowRoot;
      if (shadowRoot) {
        for (const selector of selectors) {
          const elements = shadowRoot.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            const htmlEl = el as HTMLElement;
            const elText = (htmlEl.textContent || '').trim().toLowerCase();
            
            if (elText === text && this.isValidTarget(htmlEl)) {
              return htmlEl;
            }
          }
        }
      }
      currentNode = walker.nextNode();
    }

    return null;
  }

  /* ========================================================================
     VALIDATION: IS THIS A VALID TARGET?
     ======================================================================== */

  /**
   * STRICT validation - Must pass ALL checks
   */
  private isValidTarget(el: HTMLElement): boolean {
    if (!el || !el.isConnected) {
      return false;
    }

    // CRITICAL: Ignore our own extension UI
    if (this.isOwnUI(el)) {
      return false;
    }

    // Must be visible
    if (!this.isVisible(el)) {
      return false;
    }

    // Must not be disabled
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    return true;
  }

  /**
   * Check if element is part of our extension UI
   */
  private isOwnUI(el: HTMLElement): boolean {
    // Check if element or any parent is our extension root
    let current: HTMLElement | null = el;
    while (current) {
      if (
        current.id === 'aws-nav-assistant-root' ||
        current.classList.contains('aws-nav-assistant') ||
        current.classList.contains('aws-nav-highlight-container') ||
        current.classList.contains('aws-nav-highlight-box') ||
        current.classList.contains('aws-nav-highlight-arrow') ||
        current.classList.contains('aws-nav-highlight-label')
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Strict visibility check
   */
  private isVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
    );
  }

  /* ========================================================================
     VISUAL OVERLAY (Spotlight Style)
     ======================================================================== */

  private renderOverlay(el: HTMLElement, text: string) {
    const overlay = document.createElement("div");
    overlay.className = "aws-nav-highlight-container"; // Mark as our UI
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2147483647;
      pointer-events: none;
      background: transparent;
    `;

    // Spotlight Box
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
      animation: pulse-highlight 2s ease-in-out infinite;
    `;

    // Label
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
      max-width: 280px;
      z-index: 2147483647;
      pointer-events: none;
    `;

    // Add pulse animation
    this.addPulseAnimation();

    // Position update function
    const update = () => {
      if (!el.isConnected) {
        this.clearHighlights();
        return;
      }

      const rect = el.getBoundingClientRect();
      const padding = 8;

      // Update box position
      box.style.top = `${rect.top - padding}px`;
      box.style.left = `${rect.left - padding}px`;
      box.style.width = `${rect.width + (padding * 2)}px`;
      box.style.height = `${rect.height + (padding * 2)}px`;

      // Smart label positioning (avoid top edge)
      const labelTop = rect.top - 50 < 0 ? rect.bottom + 15 : rect.top - 50;
      label.style.top = `${labelTop}px`;
      label.style.left = `${rect.left}px`;
    };

    update();

    // Observe changes
    this.resizeObserver = new ResizeObserver(update);
    this.resizeObserver.observe(el);
    this.resizeObserver.observe(document.body);
    
    window.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update, { passive: true });

    overlay.appendChild(box);
    overlay.appendChild(label);
    document.body.appendChild(overlay);

    this.overlay = overlay;
  }

  /**
   * Add CSS animation
   */
  private addPulseAnimation() {
    if (document.getElementById('aws-nav-pulse-animation')) return;

    const style = document.createElement('style');
    style.id = 'aws-nav-pulse-animation';
    style.textContent = `
      @keyframes pulse-highlight {
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

  /* ========================================================================
     EVENT BINDING
     ======================================================================== */

  private bindClick(el: HTMLElement, step: NavigationStep) {
    const handler = () => {
      console.log("[Highlighter] ✓ Click detected on step:", step.stepNumber);
      this.clearHighlights();

      // Small delay for AWS UI to react
      setTimeout(() => {
        window.postMessage(
          { 
            type: "AWS_NAV_STEP_COMPLETED", 
            stepNumber: step.stepNumber 
          }, 
          "*"
        );
      }, 100);
    };

    // Capture phase to catch before AWS stops propagation
    el.addEventListener("click", handler, { once: true, capture: true });
  }
}

export const highlighter = new ElementHighlighter();