// ============================================================
// Navigation Watcher
// Detects AWS SPA navigation (URL changes without page reload)
// and waits for the new page's DOM to settle before proceeding.
// ============================================================

type NavigationCallback = (newUrl: string) => void;

/**
 * Watch for URL changes in the AWS Console SPA.
 * Returns a cleanup function to stop watching.
 */
export function watchForNavigation(callback: NavigationCallback): () => void {
  let lastUrl = location.href;
  let isActive = true;

  // Method 1: Poll URL every 300ms
  const intervalId = setInterval(() => {
    if (!isActive) return;
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log("[NavWatcher] URL change detected (poll):", currentUrl);
      callback(currentUrl);
    }
  }, 300);

  // Method 2: MutationObserver on document body
  // AWS Console modifies DOM on navigation, this catches it faster
  const observer = new MutationObserver(() => {
    if (!isActive) return;
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log("[NavWatcher] URL change detected (mutation):", currentUrl);
      callback(currentUrl);
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  // Method 3: Listen for popstate (back/forward navigation)
  const popstateHandler = () => {
    if (!isActive) return;
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      console.log("[NavWatcher] URL change detected (popstate):", currentUrl);
      callback(currentUrl);
    }
  };
  window.addEventListener("popstate", popstateHandler);

  // Cleanup function
  return () => {
    isActive = false;
    clearInterval(intervalId);
    observer.disconnect();
    window.removeEventListener("popstate", popstateHandler);
    console.log("[NavWatcher] Stopped watching");
  };
}

/**
 * Wait for the DOM to settle (stop changing) after a navigation.
 * Uses a debounced MutationObserver with a quiet period.
 *
 * @param quietPeriodMs - How long the DOM must be "quiet" (default: 800ms)
 * @param maxWaitMs - Maximum time to wait before giving up (default: 5000ms)
 */
export function waitForDomSettle(
  quietPeriodMs = 800,
  maxWaitMs = 5000
): Promise<void> {
  return new Promise((resolve) => {
    let debounceTimer: ReturnType<typeof setTimeout>;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(maxTimer);
      clearTimeout(debounceTimer);
      resolve();
    };

    // Max timeout — don't wait forever
    const maxTimer = setTimeout(() => {
      console.log("[NavWatcher] DOM settle timeout reached, proceeding");
      finish();
    }, maxWaitMs);

    // Observe DOM changes
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("[NavWatcher] DOM settled (quiet for", quietPeriodMs, "ms)");
        finish();
      }, quietPeriodMs);
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });

    // Start the initial quiet period timer
    // (in case the DOM is already settled when we start watching)
    debounceTimer = setTimeout(() => {
      console.log("[NavWatcher] DOM was already quiet, proceeding");
      finish();
    }, quietPeriodMs);
  });
}

/**
 * Watch for page visibility changes (tab switch, window minimize).
 * Calls the callback with true when the page becomes visible,
 * and false when it becomes hidden.
 *
 * Returns a cleanup function.
 */
export function watchVisibility(
  callback: (isVisible: boolean) => void
): () => void {
  const handler = () => {
    const visible = document.visibilityState === "visible";
    console.log("[NavWatcher] Visibility changed:", visible ? "visible" : "hidden");
    callback(visible);
  };

  document.addEventListener("visibilitychange", handler);

  return () => {
    document.removeEventListener("visibilitychange", handler);
    console.log("[NavWatcher] Stopped watching visibility");
  };
}

/**
 * Watch for window focus/blur events.
 * Useful as a secondary signal for tab switching.
 *
 * Returns a cleanup function.
 */
export function watchTabFocus(
  callback: (hasFocus: boolean) => void
): () => void {
  const focusHandler = () => {
    console.log("[NavWatcher] Window focused");
    callback(true);
  };
  const blurHandler = () => {
    console.log("[NavWatcher] Window blurred");
    callback(false);
  };

  window.addEventListener("focus", focusHandler);
  window.addEventListener("blur", blurHandler);

  return () => {
    window.removeEventListener("focus", focusHandler);
    window.removeEventListener("blur", blurHandler);
    console.log("[NavWatcher] Stopped watching tab focus");
  };
}
