import { createRoot } from 'react-dom/client';
import { App } from './App';

console.log('[Content Script] AWS Navigation Assistant v2 loaded');

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
  // Navigation watching is now handled inside App.tsx via navigationWatcher.ts
  const root = createRoot(rootContainer);
  root.render(<App />);

  console.log('[Content Script] React app rendered (v2 - context-aware)');
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}

export {};