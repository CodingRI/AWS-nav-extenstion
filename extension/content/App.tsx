import React, { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, X, Minimize2, Maximize2, Send, Loader2, CheckCircle2, Circle, Square, RefreshCw, AlertTriangle } from 'lucide-react';
import type { GuidanceStep, GuidanceSession, NextStepRequest, NextStepResponse, PageContext } from "@aws-nav/shared";
import { highlighter } from './highlighter';
import { grabPageContext } from './contextGrabber';
import * as sessionManager from './sessionManager';
import { watchForNavigation, waitForDomSettle, watchVisibility } from './navigationWatcher';
import './App.css';

interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: number;
  retryAction?: 'retry-step' | 'retry-fresh';
}

// Backend API URL
const API_BASE_URL = 'http://localhost:3000';

// How often to check for session expiry (every 30 seconds)
const EXPIRY_CHECK_INTERVAL_MS = 30 * 1000;

// Max retries for element-not-found before asking user
const MAX_AUTO_RETRIES = 2;

export const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'assistant',
      content: 'Hi! Ask me how to do something on AWS and I\'ll guide you step by step.',
      timestamp: Date.now(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState<GuidanceSession | null>(null);
  const [currentStep, setCurrentStep] = useState<GuidanceStep | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navCleanupRef = useRef<(() => void) | null>(null);
  const visCleanupRef = useRef<(() => void) | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [isOpen, isMinimized]);

  // On mount: check for existing session, start watchers, start expiry timer
  useEffect(() => {
    const init = async () => {
      const existingSession = await sessionManager.getActiveSession();

      if (existingSession) {
        setSession(existingSession);

        if (existingSession.status === 'active') {
          console.log('[App] Resuming active session:', existingSession.sessionId);
          addMessage('system', '🔄 Resuming previous guidance session...');
          setIsOpen(true);
          await waitForDomSettle();
          await requestNextStep(existingSession);

        } else if (existingSession.status === 'paused') {
          console.log('[App] Found paused session:', existingSession.sessionId);
          if (sessionManager.shouldAutoResume(existingSession, window.location.href)) {
            console.log('[App] Back at paused URL, auto-resuming!');
            addMessage('system', '🔄 Welcome back! Resuming guidance...');
            setIsOpen(true);
            const resumed = await sessionManager.resumeSession();
            if (resumed) {
              setSession(resumed);
              await waitForDomSettle();
              await requestNextStep(resumed);
            }
          } else {
            addMessage('system', `⏸ Guidance paused. Navigate back or click Resume.`);
            setIsOpen(true);
          }
        }
      }
    };

    init();

    navCleanupRef.current = watchForNavigation(handleUrlChange);
    visCleanupRef.current = watchVisibility(handleVisibilityChange);
    expiryTimerRef.current = setInterval(checkSessionExpiry, EXPIRY_CHECK_INTERVAL_MS);

    return () => {
      navCleanupRef.current?.();
      visCleanupRef.current?.();
      if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addMessage = useCallback((
    type: 'user' | 'assistant' | 'system' | 'error',
    content: string,
    retryAction?: 'retry-step' | 'retry-fresh'
  ) => {
    const newMessage: Message = {
      id: Date.now().toString() + Math.random().toString(36).substring(2),
      type,
      content,
      timestamp: Date.now(),
      retryAction,
    };
    setMessages((prev) => [...prev, newMessage]);
  }, []);

  /* ========================================================================
     SESSION EXPIRY CHECK
     ======================================================================== */

  const checkSessionExpiry = async () => {
    const currentSession = await sessionManager.getActiveSession();
    if (!currentSession && session) {
      console.log('[App] Session expired, cleaning up');
      highlighter.clearHighlights();
      setSession(null);
      setCurrentStep(null);
      setRetryCount(0);
      addMessage('system', '⏰ Guidance session expired due to inactivity.');
    }
  };

  /* ========================================================================
     VISIBILITY CHANGE HANDLER (Tab Switch)
     ======================================================================== */

  const handleVisibilityChange = useCallback(async (isVisible: boolean) => {
    if (!isVisible) {
      console.log('[App] Tab hidden, session continues in background');
      return;
    }

    console.log('[App] Tab visible again, checking session state...');

    const currentSession = await sessionManager.getActiveSession();
    if (!currentSession) {
      if (session) {
        highlighter.clearHighlights();
        setSession(null);
        setCurrentStep(null);
        setRetryCount(0);
        addMessage('system', '⏰ Guidance session expired while you were away.');
      }
      return;
    }

    setSession(currentSession);

    if (currentSession.status === 'paused') {
      if (sessionManager.shouldAutoResume(currentSession, window.location.href)) {
        console.log('[App] Auto-resuming after tab switch');
        addMessage('system', '🔄 Welcome back! Resuming guidance...');
        const resumed = await sessionManager.resumeSession();
        if (resumed) {
          setSession(resumed);
          await waitForDomSettle();
          await requestNextStep(resumed);
        }
      }
    } else if (currentSession.status === 'active') {
      const pendingStep = sessionManager.getLastPendingStep(currentSession);
      if (pendingStep) {
        console.log('[App] Re-highlighting after tab return');
        const el = await highlighter.highlightStep(pendingStep);
        if (el) {
          attachClickHandlers(el, currentSession);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /* ========================================================================
     URL CHANGE HANDLER (SPA Navigation)
     ======================================================================== */

  const handleUrlChange = useCallback(async (newUrl: string) => {
    console.log('[App] URL changed to:', newUrl);

    const currentSession = await sessionManager.getActiveSession();
    if (!currentSession) return;

    if (currentSession.status === 'active') {
      await sessionManager.updateActiveUrl(newUrl);
      await waitForDomSettle();

      const updatedSession = await sessionManager.getActiveSession();
      if (updatedSession && updatedSession.status === 'active') {
        setSession(updatedSession);
        setRetryCount(0); // Reset retry count on new page
        await requestNextStep(updatedSession);
      }

    } else if (currentSession.status === 'paused') {
      if (sessionManager.shouldAutoResume(currentSession, newUrl)) {
        console.log('[App] User navigated back to paused URL, auto-resuming!');
        addMessage('system', '🔄 Back at the guided page! Resuming...');

        const resumed = await sessionManager.resumeSession();
        if (resumed) {
          await sessionManager.updateActiveUrl(newUrl);
          setSession(resumed);
          setRetryCount(0);
          await waitForDomSettle();

          const pendingStep = sessionManager.getLastPendingStep(resumed);
          if (pendingStep) {
            const el = await highlighter.highlightStep(pendingStep);
            if (el) {
              attachClickHandlers(el, resumed);
            } else {
              await requestNextStep(resumed);
            }
          } else {
            await requestNextStep(resumed);
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ========================================================================
     CLICK HANDLER ATTACHMENT (extracted for reuse)
     ======================================================================== */

  const attachClickHandlers = (el: HTMLElement, activeSession: GuidanceSession) => {
    highlighter.attachClickDetection(
      el,
      async () => {
        console.log('[App] Target clicked, advancing...');
        await sessionManager.completeCurrentStep();
        setRetryCount(0); // Reset on successful click

        setTimeout(async () => {
          const s = await sessionManager.getActiveSession();
          if (s && s.status === 'active') {
            setSession(s);
            await waitForDomSettle(600, 3000);
            await requestNextStep(s);
          }
        }, 800);
      },
      async () => {
        console.log('[App] Non-target click, pausing guidance');
        await sessionManager.pauseSession('non-target-click');
        const s = await sessionManager.getActiveSession();
        setSession(s);
        setCurrentStep(null);
        setRetryCount(0);
        addMessage('system', '⏸ Guidance paused — you clicked a different element. Navigate back to the guided page or click Resume to continue.');
      }
    );
  };

  /* ========================================================================
     AI STEP REQUEST (with retry-with-re-context)
     ======================================================================== */

  const requestNextStep = async (activeSession: GuidanceSession, isRetry = false) => {
    setIsLoading(true);

    try {
      // Phase 1: Grab page context
      const pageContext: PageContext = grabPageContext();

      console.log('[App] Requesting next step:', {
        goal: activeSession.goal,
        service: pageContext.service,
        stepsCompleted: activeSession.steps.length,
        isRetry,
      });

      // Phase 2: Send to backend
      const request: NextStepRequest = {
        goal: activeSession.goal,
        pageContext,
        history: sessionManager.getCompletedSteps(activeSession),
        sessionId: activeSession.sessionId,
      };

      const response = await fetch(`${API_BASE_URL}/api/next-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: NextStepResponse = await response.json();
      console.log('[App] AI response:', data);

      if (!data.success) {
        throw new Error(data.error || 'Failed to generate step');
      }

      // Phase 3: Check if goal is complete
      if (data.isComplete) {
        addMessage('assistant', `🎉 ${data.message || 'Goal completed!'}`);
        await sessionManager.completeSession();
        setSession(null);
        setCurrentStep(null);
        setRetryCount(0);
        highlighter.clearHighlights();
        return;
      }

      // Assign step index
      const step: GuidanceStep = {
        ...data.step,
        stepIndex: activeSession.steps.length,
        pageUrl: window.location.href,
      };

      // If this is a retry, remove the last pending step to replace it
      if (isRetry) {
        const lastStep = sessionManager.getLastPendingStep(activeSession);
        if (lastStep) {
          // Remove it by completing the session step list trim
          activeSession.steps = activeSession.steps.filter(s => s.completedAt != null || s !== lastStep);
        }
      }

      // Add step to session
      const updatedSession = await sessionManager.addStep(step);
      setSession(updatedSession);
      setCurrentStep(step);

      if (!isRetry) {
        addMessage('assistant', step.instruction);
      } else {
        addMessage('assistant', `🔄 ${step.instruction}`);
      }

      // Phase 4: Find and highlight the element
      const el = await highlighter.highlightStep(step);

      if (!el) {
        // Element not found — attempt auto-retry with fresh context
        const currentRetry = retryCount + 1;
        setRetryCount(currentRetry);

        if (currentRetry <= MAX_AUTO_RETRIES) {
          console.log(`[App] Element not found, auto-retrying (${currentRetry}/${MAX_AUTO_RETRIES})...`);
          addMessage('system', `🔄 Element not found, re-analyzing page... (attempt ${currentRetry}/${MAX_AUTO_RETRIES})`);

          // Wait for DOM to potentially finish loading
          await waitForDomSettle(1000, 4000);

          // Retry with fresh context
          const freshSession = await sessionManager.getActiveSession();
          if (freshSession && freshSession.status === 'active') {
            setIsLoading(false);
            await requestNextStep(freshSession, true);
          }
          return;
        }

        // Max retries exhausted — show error with Try Again button
        addMessage(
          'error',
          `⚠️ Could not find the element "${step.targetText || 'target'}" on this page after ${MAX_AUTO_RETRIES} attempts.\n\nPossible reasons:\n• The element may require scrolling\n• A dialog or dropdown needs to open first\n• The page might still be loading`,
          'retry-step'
        );
        return;
      }

      // Success! Reset retry count
      setRetryCount(0);

      // Phase 5: Attach click detection
      if (updatedSession) {
        attachClickHandlers(el, updatedSession);
      }

    } catch (err) {
      console.error('[App] Error requesting next step:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
        addMessage(
          'error',
          `🔌 Cannot connect to the backend server.\n\nMake sure the server is running:\n  cd backend && npm run dev`,
          'retry-fresh'
        );
      } else {
        addMessage(
          'error',
          `❌ ${errorMessage}`,
          'retry-fresh'
        );
      }
    } finally {
      setIsLoading(false);
    }
  };

  /* ========================================================================
     RETRY HANDLERS
     ======================================================================== */

  const handleRetryStep = async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession || activeSession.status !== 'active') {
      addMessage('system', '⚠️ No active session to retry.');
      return;
    }

    setRetryCount(0);
    addMessage('system', '🔄 Retrying with fresh page context...');
    await waitForDomSettle(500, 3000);
    await requestNextStep(activeSession, true);
  };

  const handleRetryFresh = async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession) {
      addMessage('system', '⚠️ No active session to retry.');
      return;
    }

    if (activeSession.status === 'paused') {
      await sessionManager.resumeSession();
    }

    const s = await sessionManager.getActiveSession();
    if (s) {
      setRetryCount(0);
      setSession(s);
      addMessage('system', '🔄 Retrying...');
      await requestNextStep(s);
    }
  };

  /* ========================================================================
     USER ACTIONS
     ======================================================================== */

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userGoal = inputValue.trim();
    addMessage('user', userGoal);
    setInputValue('');

    if (session) {
      await sessionManager.stopSession();
      highlighter.clearHighlights();
    }

    setRetryCount(0);
    const newSession = await sessionManager.createSession(userGoal, window.location.href);
    setSession(newSession);
    await requestNextStep(newSession);
  };

  const handleStopGuide = async () => {
    highlighter.clearHighlights();
    await sessionManager.stopSession();
    setSession(null);
    setCurrentStep(null);
    setRetryCount(0);
    addMessage('system', '🛑 Guidance stopped.');
  };

  const handleResumeGuide = async () => {
    const resumed = await sessionManager.resumeSession();
    if (resumed) {
      setSession(resumed);
      setRetryCount(0);
      addMessage('system', '▶️ Resuming guidance...');

      const pendingStep = sessionManager.getLastPendingStep(resumed);
      if (pendingStep) {
        const el = await highlighter.highlightStep(pendingStep);
        if (el) {
          attachClickHandlers(el, resumed);
          return;
        }
      }
      await requestNextStep(resumed);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const isGuidanceActive = session?.status === 'active';
  const isGuidancePaused = session?.status === 'paused';
  const completedSteps = session?.steps.filter(s => s.completedAt) || [];

  return (
    <div className="aws-nav-assistant">
      {/* Floating toggle button */}
      {!isOpen && (
        <button
          className="aws-nav-toggle"
          onClick={() => setIsOpen(true)}
          title="Open AWS Navigator"
        >
          <MessageSquare size={20} />
          {(isGuidanceActive || isGuidancePaused) && (
            <span className="aws-nav-toggle-indicator" />
          )}
        </button>
      )}

      {/* Main chat container */}
      {isOpen && (
        <div className={`aws-nav-container ${isMinimized ? 'minimized' : ''}`}>
          {/* Header */}
          <div className="aws-nav-header">
            <div className="aws-nav-header-title">
              <span>AWS Navigator</span>
              {isGuidanceActive && (
                <span className="aws-nav-status-badge active">Live</span>
              )}
              {isGuidancePaused && (
                <span className="aws-nav-status-badge paused">Paused</span>
              )}
            </div>
            <div className="aws-nav-header-actions">
              <button
                onClick={() => setIsMinimized(!isMinimized)}
                title={isMinimized ? 'Maximize' : 'Minimize'}
              >
                {isMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
              <button onClick={() => setIsOpen(false)} title="Close">
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Content */}
          {!isMinimized && (
            <>
              {/* Messages area */}
              <div className="aws-nav-messages">
                {messages.map((message) => (
                  <div key={message.id} className={`aws-nav-message ${message.type}`}>
                    <div className="aws-nav-message-content">
                      {message.type === 'error' && (
                        <AlertTriangle size={14} className="aws-nav-error-icon" />
                      )}
                      {message.content}
                    </div>
                    {/* Retry button for error messages */}
                    {message.retryAction && (
                      <button
                        className="aws-nav-retry-button"
                        onClick={() => {
                          if (message.retryAction === 'retry-step') {
                            handleRetryStep();
                          } else {
                            handleRetryFresh();
                          }
                        }}
                        disabled={isLoading}
                      >
                        <RefreshCw size={12} />
                        Try Again
                      </button>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="aws-nav-message assistant">
                    <div className="aws-nav-message-content">
                      <Loader2 size={14} className="aws-nav-spinner" />
                      {retryCount > 0
                        ? `Re-analyzing page (attempt ${retryCount + 1})...`
                        : 'Analyzing page & generating next step...'
                      }
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Step progress */}
              {completedSteps.length > 0 && (
                <div className="aws-nav-step-progress">
                  <div className="aws-nav-step-progress-header">
                    Progress ({completedSteps.length} steps completed)
                  </div>
                  <div className="aws-nav-step-list">
                    {session?.steps.map((step, index) => (
                      <div
                        key={index}
                        className={`aws-nav-step-item ${
                          step.completedAt ? 'completed' : 'current'
                        }`}
                      >
                        <div className="aws-nav-step-icon">
                          {step.completedAt ? (
                            <CheckCircle2 size={14} />
                          ) : (
                            <Circle size={14} className="pulse" />
                          )}
                        </div>
                        <div className="aws-nav-step-text">{step.instruction}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Paused session info */}
              {isGuidancePaused && session?.pausedStepInstruction && (
                <div className="aws-nav-paused-info">
                  <div className="aws-nav-paused-label">Paused at:</div>
                  <div className="aws-nav-paused-step">{session.pausedStepInstruction}</div>
                </div>
              )}

              {/* Controls area */}
              <div className="aws-nav-controls">
                {(isGuidanceActive || isGuidancePaused) && (
                  <div className="aws-nav-guide-controls">
                    {isGuidancePaused && (
                      <button className="aws-nav-button-resume" onClick={handleResumeGuide}>
                        ▶ Resume
                      </button>
                    )}
                    <button className="aws-nav-button-stop" onClick={handleStopGuide}>
                      <Square size={12} /> Stop
                    </button>
                  </div>
                )}

                {/* Input area */}
                <div className="aws-nav-input-container">
                  <input
                    ref={inputRef}
                    type="text"
                    className="aws-nav-input"
                    placeholder={isGuidanceActive ? "Ask something else..." : "What do you want to do on AWS?"}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    disabled={isLoading}
                  />
                  <button
                    className="aws-nav-send-button"
                    onClick={handleSendMessage}
                    disabled={!inputValue.trim() || isLoading}
                  >
                    <Send size={16} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};