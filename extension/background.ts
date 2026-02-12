import { MessageType, NavigationRequest, NavigationResponse, ExtensionMessage } from '@aws-nav/shared';

const BACKEND_URL = 'http://localhost:3000';

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  console.log('[Background] Received message:', message);

  switch (message.type) {
    case MessageType.GET_NAVIGATION_STEPS:
      handleGetNavigationSteps(message.payload, sendResponse);
      return true; // Keep channel open for async response

    default:
      console.warn('[Background] Unknown message type:', message.type);
  }
});

// Handle navigation steps request
async function handleGetNavigationSteps(
  payload: { query: string },
  sendResponse: (response: any) => void
) {
  try {
    console.log('[Background] Fetching navigation steps for:', payload.query);

    const response = await fetch(`${BACKEND_URL}/api/navigate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: payload.query,
      } as NavigationRequest),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: NavigationResponse = await response.json();
    console.log('[Background] Received steps:', data);

    sendResponse({ success: true, data });
  } catch (error) {
    console.error('[Background] Error fetching navigation steps:', error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Background] Extension installed:', details.reason);
  
  if (details.reason === 'install') {
    // Initialize default storage
    chrome.storage.local.set({
      sessions: [],
      settings: {
        autoHighlight: true,
        highlightColor: '#FF6B35',
      },
    });
  }
});

// Log when service worker starts
console.log('[Background] Service worker initialized');