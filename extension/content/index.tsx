import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

console.log('[Content Script] AWS Navigation Assistant loaded');

// Check if we're on an AWS console page
const isAWSConsole = (): boolean => {
  return (
    window.location.hostname.includes('console.aws.amazon.com') ||
    window.location.hostname.includes('aws.amazon.com')
  );
};

// Initialize the extension
const initializeExtension = (): void => {
  if (!isAWSConsole()) {
    console.log('[Content Script] Not on AWS console, extension will not initialize');
    return;
  }

  console.log('[Content Script] Initializing on AWS console page');

  // Check if already initialized
  if (document.getElementById('aws-nav-assistant-root')) {
    console.log('[Content Script] Already initialized');
    return;
  }

  // Create root container
  const rootContainer = document.createElement('div');
  rootContainer.id = 'aws-nav-assistant-root';
  rootContainer.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 999997;
  `;

  // Make the container's children interactive
  rootContainer.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  rootContainer.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Enable pointer events for the actual UI elements
  const style = document.createElement('style');
  style.textContent = `
    #aws-nav-assistant-root > * {
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);

  // Append to body
  document.body.appendChild(rootContainer);

  // Render React app
  const root = createRoot(rootContainer);
  root.render(<App />);

  console.log('[Content Script] React app rendered');
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}

// Handle SPA navigation (URL changes without page reload)
// This is CRITICAL for AWS console navigation
let lastUrl = location.href;
const checkUrlChange = () => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    console.log('[Content Script] ✓ Page navigation detected:', currentUrl);
    
    // Notify app about page change
    window.postMessage({
      type: 'AWS_NAV_PAGE_CHANGED',
      url: currentUrl,
    }, '*');
  }
};

// Check URL changes frequently
setInterval(checkUrlChange, 500);

// Also observe DOM mutations (catches route changes faster)
new MutationObserver(checkUrlChange).observe(document, { 
  subtree: true, 
  childList: true 
});

// Export for use in other modules
export {};