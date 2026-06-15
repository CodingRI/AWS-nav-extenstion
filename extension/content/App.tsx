import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  MessageSquare,
  X,
  Minimize2,
  Maximize2,
  Send,
  Loader2,
  CheckCircle2,
  Circle,
  Square,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import type {
  GuidanceStep,
  GuidanceSession,
  NextStepRequest,
  NextStepResponse,
  PageContext,
  SessionMessage,
} from "@aws-nav/shared";
import { highlighter } from "./highlighter";
import { grabPageContext } from "./contextGrabber";
import * as sessionManager from "./sessionManager";
import {
  watchForNavigation,
  waitForDomSettle,
  watchVisibility,
} from "./navigationWatcher";
import "./App.css";

type Message = SessionMessage;

const API_BASE_URL = "http://localhost:8000";
const EXPIRY_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_AUTO_RETRIES = 2;

export const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      type: "assistant",
      content:
        "Hi! Tell me what you want to do on AWS and I'll guide you step by step.",
      timestamp: Date.now(),
    },
  ]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState<GuidanceSession | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [pageSteps, setPageSteps] = useState<GuidanceStep[]>([]);
  const [pageStepIndex, setPageStepIndex] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navCleanupRef = useRef<(() => void) | null>(null);
  const visCleanupRef = useRef<(() => void) | null>(null);
  const requestInFlightRef = useRef(false);
  const expiryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ref that always holds the LATEST requestNextStep function.
  // This prevents stale closures in navigation callbacks and click handlers
  // which are set up at mount time and would otherwise capture stale state.
  const requestNextStepRef = useRef<
    (session: GuidanceSession, isRetry?: boolean) => Promise<void>
  >(async () => {
    /* placeholder until first render */
  });

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [isOpen, isMinimized]);

  const addMessage = useCallback(
    (
      type: "user" | "assistant" | "system" | "error",
      content: string,
      retryAction?: "retry-step" | "retry-fresh",
    ) => {
      const newMessage: Message = {
        id: Date.now().toString() + Math.random().toString(36).substring(2),
        type,
        content,
        timestamp: Date.now(),
        retryAction,
      };
      setMessages((prev) => {
        const updated = [...prev, newMessage];
        sessionManager.updateSessionMessages(updated).catch((err) => {
          console.warn("[App] Error saving messages to session:", err);
        });
        return updated;
      });
    },
    [],
  );

  function hasValidationErrors(): boolean {
    const pageText = document.body.innerText.toLowerCase();

    return (
      pageText.includes("must not be empty") ||
      pageText.includes("required") ||
      pageText.includes("invalid")
    );
  }

  /* ========================================================================
     CLICK HANDLER ATTACHMENT
     Guidance no longer pauses when user clicks elsewhere — they should be
     free to interact naturally. Guidance only advances on the target click.
     ======================================================================== */

  const advanceToNextPageStep = useCallback(async () => {
    await sessionManager.completeCurrentStep();
    setRetryCount(0);

    setPageSteps((currentSteps) => {
      setPageStepIndex((currentIndex) => {
        const nextIndex = currentIndex + 1;

        if (nextIndex < currentSteps.length) {
          const nextStep = currentSteps[nextIndex]!;
          (async () => {
            const updatedSession = await sessionManager.addStep(nextStep);
            if (updatedSession) setSession(updatedSession);
            addMessage("assistant", nextStep.instruction);

            const el = await highlighter.highlightStep(nextStep);
            if (el) {
              attachClickHandlersRef.current(el);
            }
          })();
          return nextIndex;
        }

        // All page steps done — request next from LLM
        setTimeout(async () => {
          const s = await sessionManager.getActiveSession();
          if (s && s.status === "active") {
            setSession(s);
            await waitForDomSettle(600, 3000);
            await requestNextStepRef.current(s);
          }
        }, 800);
        return currentIndex;
      });
      return currentSteps;
    });
  }, [addMessage]);

  const attachClickHandlers = useCallback(
    (el: HTMLElement) => {
      const tag = el.tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        console.log("[App] Input element — advance via Next button, not click");
        return;
      }
      highlighter.attachClickDetection(el, () => {
        console.log("[App] Target clicked, advancing...");
        advanceToNextPageStep();
      });
    },
    [advanceToNextPageStep],
  );

  const attachClickHandlersRef = useRef(attachClickHandlers);
  attachClickHandlersRef.current = attachClickHandlers;

  /* ========================================================================
     ON MOUNT: check existing session + start watchers
     ======================================================================== */

  useEffect(() => {
    const init = async () => {
      const existingSession = await sessionManager.getActiveSession();
      if (existingSession) {
        setSession(existingSession);

        // Restore message history from the active session
        if (existingSession.messages && existingSession.messages.length > 0) {
          setMessages(existingSession.messages);
        }

        if (existingSession.status === "active") {
          console.log(
            "[App] Resuming active session:",
            existingSession.sessionId,
          );
          setIsOpen(true);

          // Only add resume system message if it isn't already the last message
          const lastMsg =
            existingSession.messages?.[existingSession.messages.length - 1];
          if (
            !lastMsg ||
            lastMsg.content !== "Resuming previous guidance session..."
          ) {
            addMessage("system", "Resuming previous guidance session...");
          }

          await waitForDomSettle();
          await requestNextStepRef.current(existingSession);
        } else if (existingSession.status === "paused") {
          console.log("[App] Found paused session:", existingSession.sessionId);
          if (
            sessionManager.shouldAutoResume(
              existingSession,
              window.location.href,
            )
          ) {
            setIsOpen(true);

            // Only add resume system message if it isn't already the last message
            const lastMsg =
              existingSession.messages?.[existingSession.messages.length - 1];
            if (
              !lastMsg ||
              lastMsg.content !== "Welcome back! Resuming guidance..."
            ) {
              addMessage("system", "Welcome back! Resuming guidance...");
            }

            const resumed = await sessionManager.resumeSession();
            if (resumed) {
              setSession(resumed);
              await waitForDomSettle();
              await requestNextStepRef.current(resumed);
            }
          } else {
            const lastMsg =
              existingSession.messages?.[existingSession.messages.length - 1];
            if (
              !lastMsg ||
              lastMsg.content !== "Guidance paused. Click Resume to continue."
            ) {
              addMessage(
                "system",
                "Guidance paused. Click Resume to continue.",
              );
            }
            setIsOpen(true);
          }
        }
      }
    };

    init();

    // Navigation watcher — always calls via ref to avoid stale closures
    navCleanupRef.current = watchForNavigation(async (newUrl: string) => {
      console.log("[App] URL changed to:", newUrl);

      const currentSession = await sessionManager.getActiveSession();
      if (!currentSession) return;

      if (currentSession.status === "active") {
        await sessionManager.updateActiveUrl(newUrl);
        // Let the new page's DOM settle before grabbing context
        await waitForDomSettle(800, 4000);

        const updatedSession = await sessionManager.getActiveSession();
        if (updatedSession && updatedSession.status === "active") {
          setSession(updatedSession);
          setRetryCount(0);
          console.log(
            "[App] URL changed with active session, requesting next step",
          );
          const pendingStep = sessionManager.getLastPendingStep(updatedSession);

          if (pendingStep) {
            const el = await highlighter.highlightStep(pendingStep);

            if (el) {
              attachClickHandlers(el);
              return;
            }

            console.log("[App] Pending step no longer exists. Re-planning...");
          }

          await requestNextStepRef.current(updatedSession);
        }
      } else if (currentSession.status === "paused") {
        if (sessionManager.shouldAutoResume(currentSession, newUrl)) {
          console.log(
            "[App] User navigated back to paused URL, auto-resuming!",
          );
          addMessage("system", "Back at the guided page! Resuming...");

          const resumed = await sessionManager.resumeSession();
          if (resumed) {
            await sessionManager.updateActiveUrl(newUrl);
            setSession(resumed);
            setRetryCount(0);
            await waitForDomSettle(800, 4000);

            const pendingStep = sessionManager.getLastPendingStep(resumed);
            if (pendingStep) {
              const el = await highlighter.highlightStep(pendingStep);
              if (el) {
                attachClickHandlers(el);
                return;
              }
            }
            await requestNextStepRef.current(resumed);
          }
        }
      }
    });

    visCleanupRef.current = watchVisibility(async (isVisible: boolean) => {
      if (!isVisible) return;

      console.log("[App] Tab visible again, checking session...");
      const currentSession = await sessionManager.getActiveSession();

      if (!currentSession) {
        setSession(null);
        highlighter.clearHighlights();
        return;
      }

      setSession(currentSession);

      if (currentSession.status === "paused") {
        if (
          sessionManager.shouldAutoResume(currentSession, window.location.href)
        ) {
          addMessage("system", "Welcome back! Resuming...");
          const resumed = await sessionManager.resumeSession();
          if (resumed) {
            setSession(resumed);
            await waitForDomSettle();
            await requestNextStepRef.current(resumed);
          }
        }
      } else if (currentSession.status === "active") {
        const pendingStep = sessionManager.getLastPendingStep(currentSession);
        if (pendingStep) {
          const el = await highlighter.highlightStep(pendingStep);
          if (el) attachClickHandlers(el);
        }
      }
    });

    expiryTimerRef.current = setInterval(async () => {
      const currentSession = await sessionManager.getActiveSession();
      if (!currentSession) {
        setSession((prev) => {
          if (prev) {
            highlighter.clearHighlights();
            setRetryCount(0);
            addMessage("system", "Guidance session expired due to inactivity.");
          }
          return null;
        });
      }
    }, EXPIRY_CHECK_INTERVAL_MS);

    return () => {
      navCleanupRef.current?.();
      visCleanupRef.current?.();
      if (expiryTimerRef.current) clearInterval(expiryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ========================================================================
     AI STEP REQUEST
     ======================================================================== */

  const requestNextStep = async (
    activeSession: GuidanceSession,
    isRetry = false,
  ) => {
    if (requestInFlightRef.current) {
      return;
    }

    requestInFlightRef.current = true;
    setIsLoading(true);

    try {
      let currentSession = activeSession;

      // Phase 1: Grab prioritized page context
      const pageContext: PageContext = await grabPageContext();

      console.log("[App] Requesting next step:", {
        goal: currentSession.goal,
        service: pageContext.service,
        view: pageContext.view,
        stepsCompleted: sessionManager.getCompletedSteps(currentSession).length,
        isRetry,
      });

      // Phase 2: Send to backend
      const trimmedContext = {
        ...pageContext,
        visibleButtons: pageContext.visibleButtons.map(
          ({
            tagName,
            text,
            ariaLabel,
            role,
            value,
            placeholder,
            inputType,
            name,
          }) => ({
            tagName,
            text,
            ariaLabel,
            role,
            value,
            placeholder,
            inputType,
            name,
            dataAnalytics: null,
            selector: "",
            isVisible: true,
          }),
        ),
      };

      const request: NextStepRequest = {
        goal: currentSession.goal,
        pageContext: trimmedContext,
        history: sessionManager.getCompletedSteps(currentSession),
        sessionId: currentSession.sessionId,
      };

      const response = await fetch(`${API_BASE_URL}/api/next-step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: NextStepResponse = await response.json();
      console.log("[App] AI response:", data);

      if (!data.success) {
        throw new Error(data.error || "Failed to generate step");
      }

      // Phase 3: Check if goal is complete
      if (data.isComplete) {
        if (hasValidationErrors()) {
          console.log("[App] Validation errors detected");
        } else {
          addMessage("assistant", data.message || "Goal completed!");
          await sessionManager.completeSession();
          setSession(null);
          setRetryCount(0);
          setPageSteps([]);
          setPageStepIndex(0);
          highlighter.clearHighlights();
          return;
        }
      }

      const steps = data.steps.map((s, i) => {
        const step = {
          ...s,
          stepIndex: currentSession.steps.length + i,
          pageUrl: window.location.href,
        };

        // Match targetText against the element list we sent to the LLM
        // to get the exact tagName and selector for deterministic highlighting
        const targetNorm = (step.targetText || "").trim().toLowerCase();
        if (targetNorm) {
          const match = pageContext.visibleButtons.find(
            (el) => el.text.trim().toLowerCase() === targetNorm,
          );
          if (match) {
            step.tagHint = match.tagName;
            step.selectorHint = match.selector;
            console.log(
              `[App] Tag hint for "${step.targetText}": <${match.tagName}> selector="${match.selector}"`,
            );
          }
        }

        return step;
      });

      // Store all page steps for cycling
      setPageSteps(steps);
      setPageStepIndex(0);

      // Start with the first step
      const firstStep = steps[0]!;
      const updatedSession = await sessionManager.addStep(firstStep);
      setSession(updatedSession);
      addMessage("assistant", firstStep.instruction);
      if (steps.length > 1) {
        addMessage(
          "system",
          `${steps.length} actions on this page — use "Next" after each one.`,
        );
      }

      // Phase 4: Find and highlight the first element
      const el = await highlighter.highlightStep(firstStep);

      if (!el) {
        console.log(
          "[App] Element not found. Strategy:",
          highlighter.getLastFindStrategy(),
        );
        const currentRetry = retryCount + 1;
        setRetryCount(currentRetry);

        if (currentRetry <= MAX_AUTO_RETRIES) {
          console.log(
            `[App] Element not found, auto-retrying (${currentRetry}/${MAX_AUTO_RETRIES})...`,
          );
          addMessage(
            "system",
            `Element not found, re-analyzing page... (attempt ${currentRetry}/${MAX_AUTO_RETRIES})`,
          );

          await waitForDomSettle(1000, 4000);
          const freshSession = await sessionManager.getActiveSession();
          if (freshSession && freshSession.status === "active") {
            setIsLoading(false);
            await requestNextStep(freshSession, true);
          }
          return;
        }

        addMessage(
          "error",
          `Could not find "${firstStep.targetText || "the target element"}" on this page after ${MAX_AUTO_RETRIES} attempts.\n\nTry: scrolling down, opening a required dropdown first, or waiting for the page to load.`,
          "retry-step",
        );
        return;
      }

      // Success
      setRetryCount(0);
      if (updatedSession) {
        attachClickHandlers(el);
      }
    } catch (err) {
      console.error("[App] Error requesting next step:", err);
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      if (
        errorMessage.includes("Failed to fetch") ||
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("ECONNREFUSED")
      ) {
        addMessage(
          "error",
          "Cannot connect to the backend server.\n\nRun: cd backend && npm run dev",
          "retry-fresh",
        );
      } else {
        addMessage("error", errorMessage, "retry-fresh");
      }
    } finally {
      setIsLoading(false);
    }

    requestInFlightRef.current = false;
  };

  // Keep the ref in sync with the latest requestNextStep function after every render
  // This is the key fix for stale closures in navigation/click callbacks
  requestNextStepRef.current = requestNextStep;

  /* ========================================================================
     RETRY HANDLERS
     ======================================================================== */

  const handleRetryStep = async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession || activeSession.status !== "active") {
      addMessage("system", "No active session to retry.");
      return;
    }
    setRetryCount(0);
    addMessage("system", "Retrying with fresh page context...");
    await waitForDomSettle(500, 3000);
    await requestNextStep(activeSession, true);
  };

  const handleRetryFresh = async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession) {
      addMessage("system", "No active session to retry.");
      return;
    }

    if (activeSession.status === "paused") {
      await sessionManager.resumeSession();
    }

    const s = await sessionManager.getActiveSession();
    if (s) {
      setRetryCount(0);
      setSession(s);
      addMessage("system", "Retrying...");
      await requestNextStep(s);
    }
  };

  /* ========================================================================
     USER ACTIONS
     ======================================================================== */

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userGoal = inputValue.trim();
    setInputValue("");

    if (session) {
      await sessionManager.stopSession();
      highlighter.clearHighlights();
    }

    setRetryCount(0);
    const newSession = await sessionManager.createSession(
      userGoal,
      window.location.href,
    );

    // Initialize session message history with the user goal
    const initialUserMessage: Message = {
      id: Date.now().toString(),
      type: "user",
      content: userGoal,
      timestamp: Date.now(),
    };

    setMessages([initialUserMessage]);
    newSession.messages = [initialUserMessage];
    await sessionManager.updateSessionMessages([initialUserMessage]);

    setSession(newSession);
    await requestNextStep(newSession);
  };

  const handleNextPageStep = async () => {
    await advanceToNextPageStep();
  };

  const handleStopGuide = async () => {
    highlighter.clearHighlights();
    await sessionManager.stopSession();
    setSession(null);
    setRetryCount(0);
    setPageSteps([]);
    setPageStepIndex(0);
    addMessage("system", "Guidance stopped.");
  };

  const handleResumeGuide = async () => {
    const resumed = await sessionManager.resumeSession();
    if (resumed) {
      setSession(resumed);
      setRetryCount(0);
      addMessage("system", "Resuming guidance...");

      const pendingStep = sessionManager.getLastPendingStep(resumed);
      if (pendingStep) {
        const el = await highlighter.highlightStep(pendingStep);
        if (el) {
          attachClickHandlers(el);
          return;
        }
      }
      await requestNextStep(resumed);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const isGuidanceActive = session?.status === "active";
  const isGuidancePaused = session?.status === "paused";
  const completedSteps = session?.steps.filter((s) => s.completedAt) || [];
  const hasMorePageSteps =
    pageSteps.length > 1 && pageStepIndex < pageSteps.length - 1;

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
        <div className={`aws-nav-container ${isMinimized ? "minimized" : ""}`}>
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
                title={isMinimized ? "Maximize" : "Minimize"}
              >
                {isMinimized ? (
                  <Maximize2 size={16} />
                ) : (
                  <Minimize2 size={16} />
                )}
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
                  <div
                    key={message.id}
                    className={`aws-nav-message ${message.type}`}
                  >
                    <div className="aws-nav-message-content">
                      {message.type === "error" && (
                        <AlertTriangle
                          size={14}
                          className="aws-nav-error-icon"
                        />
                      )}
                      {message.content}
                    </div>
                    {message.retryAction && (
                      <button
                        className="aws-nav-retry-button"
                        onClick={() => {
                          if (message.retryAction === "retry-step") {
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
                        : "Analyzing page & generating next step..."}
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Step progress */}
              {completedSteps.length > 0 && (
                <div className="aws-nav-step-progress">
                  <div className="aws-nav-step-progress-header">
                    Progress ({completedSteps.length} step
                    {completedSteps.length !== 1 ? "s" : ""} completed)
                  </div>
                  <div className="aws-nav-step-list">
                    {session?.steps.map((step, index) => (
                      <div
                        key={index}
                        className={`aws-nav-step-item ${step.completedAt ? "completed" : "current"}`}
                      >
                        <div className="aws-nav-step-icon">
                          {step.completedAt ? (
                            <CheckCircle2 size={14} />
                          ) : (
                            <Circle size={14} className="pulse" />
                          )}
                        </div>
                        <div className="aws-nav-step-text">
                          {step.instruction}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Paused session info */}
              {isGuidancePaused && session?.pausedStepInstruction && (
                <div className="aws-nav-paused-info">
                  <div className="aws-nav-paused-label">Paused at:</div>
                  <div className="aws-nav-paused-step">
                    {session.pausedStepInstruction}
                  </div>
                </div>
              )}

              {/* Controls area */}
              <div className="aws-nav-controls">
                {(isGuidanceActive || isGuidancePaused) && (
                  <div className="aws-nav-guide-controls">
                    {hasMorePageSteps && isGuidanceActive && (
                      <button
                        className="aws-nav-button-next"
                        onClick={handleNextPageStep}
                        disabled={isLoading}
                      >
                        Next <ChevronRight size={14} />
                        <span className="aws-nav-step-counter">
                          {pageStepIndex + 1}/{pageSteps.length}
                        </span>
                      </button>
                    )}
                    {isGuidancePaused && (
                      <button
                        className="aws-nav-button-resume"
                        onClick={handleResumeGuide}
                      >
                        ▶ Resume
                      </button>
                    )}
                    <button
                      className="aws-nav-button-stop"
                      onClick={handleStopGuide}
                    >
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
                    placeholder={
                      isGuidanceActive
                        ? "Ask something else..."
                        : "What do you want to do on AWS?"
                    }
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
