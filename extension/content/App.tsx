import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  RefreshCw,
  Send,
  Settings,
  Square,
  X,
} from "lucide-react";
import type {
  GuidanceSession,
  GuidanceStep,
  NextStepRequest,
  NextStepResponse,
  OpenRouterModel,
  PageContext,
  RuntimeResult,
  SessionMessage,
} from "@aws-nav/shared";
import { saveSelectedModel } from "../src/services/configStorage";
import { OnboardingView } from "./components/OnboardingView";
import { SettingsView } from "./components/SettingsView";
import { ModelSelector } from "./components/ModelSelector";
import { grabPageContext } from "./contextGrabber";
import { highlighter } from "./highlighter";
import { useOpenRouterConfiguration } from "./hooks/useOpenRouterConfiguration";
import { MessageType } from "./messageTypes";
import {
  waitForDomSettle,
  watchForNavigation,
  watchVisibility,
} from "./navigationWatcher";
import { sendRuntimeMessage } from "./runtime";
import * as sessionManager from "./sessionManager";
import "./App.css";

type Message = SessionMessage;
type PanelView = "chat" | "settings" | "onboarding" | "model";

const EXPIRY_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_AUTO_RETRIES = 2;
const INITIAL_ASSISTANT_MESSAGE: Message = {
  id: "1",
  type: "assistant",
  content: "Hi! Tell me what you want to do on AWS and I'll guide you step by step.",
  timestamp: Date.now(),
};

export const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("chat");
  const [onboardingInitialStep, setOnboardingInitialStep] = useState<"welcome" | "input">("welcome");
  const [messages, setMessages] = useState<Message[]>([INITIAL_ASSISTANT_MESSAGE]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState<GuidanceSession | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [pageSteps, setPageSteps] = useState<GuidanceStep[]>([]);
  const [pageStepIndex, setPageStepIndex] = useState(0);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [availableModels, setAvailableModels] = useState<OpenRouterModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);

  const {
    configurationStatus,
    isLoading: isConfigurationLoading,
    recoveryMessage,
    refreshConfiguration,
    disconnect,
    markConfigurationInvalid,
    clearRecoveryMessage,
  } = useOpenRouterConfiguration();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navCleanupRef = useRef<(() => void) | null>(null);
  const visCleanupRef = useRef<(() => void) | null>(null);
  const requestInFlightRef = useRef(false);
  const expiryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestNextStepRef = useRef<
    (activeSession: GuidanceSession, isRetry?: boolean) => Promise<void>
  >(async () => {});

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isOpen && !isMinimized && panelView === "chat") {
      inputRef.current?.focus();
    }
  }, [isOpen, isMinimized, panelView]);

  useEffect(() => {
    if (!configurationStatus) {
      return;
    }

    if (!configurationStatus.isConfigured) {
      setPanelView("onboarding");
    }
  }, [configurationStatus]);

  const addMessage = useCallback(
    (
      type: Message["type"],
      content: string,
      retryAction?: Message["retryAction"],
    ) => {
      const newMessage: Message = {
        id: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type,
        content,
        timestamp: Date.now(),
        retryAction,
      };

      setMessages((currentMessages) => {
        const updatedMessages = [...currentMessages, newMessage];
        void sessionManager.updateSessionMessages(updatedMessages);
        return updatedMessages;
      });
    },
    [],
  );

  const resetGuidanceState = useCallback(() => {
    setSession(null);
    setRetryCount(0);
    setPageSteps([]);
    setPageStepIndex(0);
    highlighter.clearHighlights();
  }, []);

  const stopGuidanceSilently = useCallback(async () => {
    await sessionManager.stopSession();
    resetGuidanceState();
  }, [resetGuidanceState]);

  const handleConfigurationInvalidation = useCallback(
    async (message: string) => {
      await stopGuidanceSilently();
      await markConfigurationInvalid(message);
      setOnboardingInitialStep("input");
      setPanelView("onboarding");
      setIsOpen(true);
    },
    [markConfigurationInvalid, stopGuidanceSilently],
  );

  function hasValidationErrors(): boolean {
    const pageText = document.body.innerText.toLowerCase();

    return (
      pageText.includes("must not be empty") ||
      pageText.includes("required") ||
      pageText.includes("invalid")
    );
  }

  const advanceToNextPageStep = useCallback(async () => {
    await sessionManager.completeCurrentStep();
    setRetryCount(0);

    setPageSteps((currentSteps) => {
      setPageStepIndex((currentIndex) => {
        const nextIndex = currentIndex + 1;

        if (nextIndex < currentSteps.length) {
          const nextStep = currentSteps[nextIndex];

          if (nextStep) {
            void (async () => {
              const updatedSession = await sessionManager.addStep(nextStep);
              if (updatedSession) {
                setSession(updatedSession);
              }
              addMessage("assistant", nextStep.instruction);

              const element = await highlighter.highlightStep(nextStep);
              if (element) {
                attachClickHandlersRef.current(element);
              }
            })();
          }

          return nextIndex;
        }

        setTimeout(() => {
          void (async () => {
            const activeSession = await sessionManager.getActiveSession();
            if (activeSession && activeSession.status === "active") {
              setSession(activeSession);
              await waitForDomSettle(600, 3000);
              await requestNextStepRef.current(activeSession);
            }
          })();
        }, 800);

        return currentIndex;
      });

      return currentSteps;
    });
  }, [addMessage]);

  const attachClickHandlers = useCallback(
    (element: HTMLElement) => {
      const tagName = element.tagName.toUpperCase();

      if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
        return;
      }

      highlighter.attachClickDetection(element, () => {
        void advanceToNextPageStep();
      });
    },
    [advanceToNextPageStep],
  );

  const attachClickHandlersRef = useRef(attachClickHandlers);
  attachClickHandlersRef.current = attachClickHandlers;

  useEffect(() => {
    const init = async () => {
      const existingSession = await sessionManager.getActiveSession();

      if (!existingSession) {
        return;
      }

      setSession(existingSession);

      if (existingSession.messages && existingSession.messages.length > 0) {
        setMessages(existingSession.messages);
      }

      if (existingSession.status === "active") {
        setIsOpen(true);
        const lastMessage =
          existingSession.messages?.[existingSession.messages.length - 1];
        if (!lastMessage || lastMessage.content !== "Resuming previous guidance session...") {
          addMessage("system", "Resuming previous guidance session...");
        }

        await waitForDomSettle();
        await requestNextStepRef.current(existingSession);
      } else if (existingSession.status === "paused") {
        if (
          sessionManager.shouldAutoResume(
            existingSession,
            window.location.href,
          )
        ) {
          setIsOpen(true);
          const lastMessage =
            existingSession.messages?.[existingSession.messages.length - 1];

          if (!lastMessage || lastMessage.content !== "Welcome back! Resuming guidance...") {
            addMessage("system", "Welcome back! Resuming guidance...");
          }

          const resumed = await sessionManager.resumeSession();
          if (resumed) {
            setSession(resumed);
            await waitForDomSettle();
            await requestNextStepRef.current(resumed);
          }
        } else {
          const lastMessage =
            existingSession.messages?.[existingSession.messages.length - 1];

          if (!lastMessage || lastMessage.content !== "Guidance paused. Click Resume to continue.") {
            addMessage("system", "Guidance paused. Click Resume to continue.");
          }
          setIsOpen(true);
        }
      }
    };

    void init();

    navCleanupRef.current = watchForNavigation(async (newUrl: string) => {
      const currentSession = await sessionManager.getActiveSession();
      if (!currentSession) {
        return;
      }

      if (currentSession.status === "active") {
        await sessionManager.updateActiveUrl(newUrl);
        await waitForDomSettle(800, 4000);

        const updatedSession = await sessionManager.getActiveSession();
        if (updatedSession && updatedSession.status === "active") {
          setSession(updatedSession);
          setRetryCount(0);
          const pendingStep = sessionManager.getLastPendingStep(updatedSession);

          if (pendingStep) {
            const element = await highlighter.highlightStep(pendingStep);
            if (element) {
              attachClickHandlersRef.current(element);
              return;
            }
          }

          await requestNextStepRef.current(updatedSession);
        }
      } else if (currentSession.status === "paused") {
        if (sessionManager.shouldAutoResume(currentSession, newUrl)) {
          addMessage("system", "Back at the guided page! Resuming...");
          const resumed = await sessionManager.resumeSession();
          if (resumed) {
            await sessionManager.updateActiveUrl(newUrl);
            setSession(resumed);
            setRetryCount(0);
            await waitForDomSettle(800, 4000);

            const pendingStep = sessionManager.getLastPendingStep(resumed);
            if (pendingStep) {
              const element = await highlighter.highlightStep(pendingStep);
              if (element) {
                attachClickHandlersRef.current(element);
                return;
              }
            }

            await requestNextStepRef.current(resumed);
          }
        }
      }
    });

    visCleanupRef.current = watchVisibility(async (isVisible: boolean) => {
      if (!isVisible) {
        return;
      }

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
          const element = await highlighter.highlightStep(pendingStep);
          if (element) {
            attachClickHandlersRef.current(element);
          }
        }
      }
    });

    expiryTimerRef.current = setInterval(() => {
      void (async () => {
        const currentSession = await sessionManager.getActiveSession();
        if (!currentSession) {
          setSession((previousSession) => {
            if (previousSession) {
              highlighter.clearHighlights();
              setRetryCount(0);
              addMessage("system", "Guidance session expired due to inactivity.");
            }
            return null;
          });
        }
      })();
    }, EXPIRY_CHECK_INTERVAL_MS);

    return () => {
      navCleanupRef.current?.();
      visCleanupRef.current?.();
      if (expiryTimerRef.current) {
        clearInterval(expiryTimerRef.current);
      }
    };
  }, [addMessage]);

  const requestNextStep = useCallback(
    async (activeSession: GuidanceSession, isRetry = false) => {
      if (requestInFlightRef.current) {
        return;
      }

      if (!configurationStatus?.isConfigured) {
        setOnboardingInitialStep("input");
        setPanelView("onboarding");
        setIsOpen(true);
        return;
      }

      requestInFlightRef.current = true;
      setIsLoading(true);

      try {
        const pageContext: PageContext = await grabPageContext();

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
          goal: activeSession.goal,
          pageContext: trimmedContext,
          history: sessionManager.getCompletedSteps(activeSession),
          sessionId: activeSession.sessionId,
        };

        const response = await sendRuntimeMessage<RuntimeResult<NextStepResponse>>({
          type: MessageType.REQUEST_NEXT_STEP,
          payload: request,
        });

        if (!response.success || !response.data) {
          const errorMessage =
            response.error?.message ?? "Failed to generate next step.";

          if (response.error?.code === "auth_invalidated") {
            await handleConfigurationInvalidation(errorMessage);
            return;
          }

          if (response.error?.code === "not_configured") {
            setOnboardingInitialStep("input");
            setPanelView("onboarding");
            setIsOpen(true);
            return;
          }

          throw new Error(errorMessage);
        }

        const data = response.data;

        if (!data.success) {
          throw new Error(data.error || "Failed to generate step");
        }

        if (data.isComplete) {
          if (!hasValidationErrors()) {
            addMessage("assistant", data.message || "Goal completed!");
            await sessionManager.completeSession();
            resetGuidanceState();
            return;
          }
        }

        const steps = data.steps.map((step, index) => {
          const nextStep: GuidanceStep = {
            ...step,
            stepIndex: activeSession.steps.length + index,
            pageUrl: window.location.href,
          };

          const normalizedTarget = (nextStep.targetText || "").trim().toLowerCase();
          if (normalizedTarget) {
            const matchingElement = pageContext.visibleButtons.find(
              (element) => element.text.trim().toLowerCase() === normalizedTarget,
            );
            if (matchingElement) {
              nextStep.tagHint = matchingElement.tagName;
              nextStep.selectorHint = matchingElement.selector;
            }
          }

          return nextStep;
        });

        setPageSteps(steps);
        setPageStepIndex(0);

        const firstStep = steps[0];
        if (!firstStep) {
          throw new Error("OpenRouter did not return any next steps.");
        }

        const updatedSession = await sessionManager.addStep(firstStep);
        setSession(updatedSession);
        addMessage("assistant", firstStep.instruction);

        if (steps.length > 1) {
          addMessage(
            "system",
            `${steps.length} actions on this page — use "Next" after each one.`,
          );
        }

        const element = await highlighter.highlightStep(firstStep);
        if (!element) {
          const nextRetryCount = retryCount + 1;
          setRetryCount(nextRetryCount);

          if (nextRetryCount <= MAX_AUTO_RETRIES) {
            addMessage(
              "system",
              `Element not found, re-analyzing page... (attempt ${nextRetryCount}/${MAX_AUTO_RETRIES})`,
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

        setRetryCount(0);
        if (updatedSession) {
          attachClickHandlersRef.current(element);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        addMessage("error", errorMessage, isRetry ? "retry-step" : "retry-fresh");
      } finally {
        setIsLoading(false);
        requestInFlightRef.current = false;
      }
    },
    [
      addMessage,
      configurationStatus?.isConfigured,
      handleConfigurationInvalidation,
      resetGuidanceState,
      retryCount,
    ],
  );

  requestNextStepRef.current = requestNextStep;

  const handleRetryStep = useCallback(async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession || activeSession.status !== "active") {
      addMessage("system", "No active session to retry.");
      return;
    }

    setRetryCount(0);
    addMessage("system", "Retrying with fresh page context...");
    await waitForDomSettle(500, 3000);
    await requestNextStep(activeSession, true);
  }, [addMessage, requestNextStep]);

  const handleRetryFresh = useCallback(async () => {
    const activeSession = await sessionManager.getActiveSession();
    if (!activeSession) {
      addMessage("system", "No active session to retry.");
      return;
    }

    if (activeSession.status === "paused") {
      await sessionManager.resumeSession();
    }

    const resumedSession = await sessionManager.getActiveSession();
    if (resumedSession) {
      setRetryCount(0);
      setSession(resumedSession);
      addMessage("system", "Retrying...");
      await requestNextStep(resumedSession);
    }
  }, [addMessage, requestNextStep]);

  const handleSendMessage = useCallback(async () => {
    if (!inputValue.trim() || isLoading) {
      return;
    }

    if (!configurationStatus?.isConfigured) {
      setOnboardingInitialStep("input");
      setPanelView("onboarding");
      setIsOpen(true);
      return;
    }

    const userGoal = inputValue.trim();
    setInputValue("");

    if (session) {
      await stopGuidanceSilently();
    }

    setRetryCount(0);
    const newSession = await sessionManager.createSession(
      userGoal,
      window.location.href,
    );

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
  }, [
    configurationStatus?.isConfigured,
    inputValue,
    isLoading,
    requestNextStep,
    session,
    stopGuidanceSilently,
  ]);

  const handleStopGuide = useCallback(async () => {
    await stopGuidanceSilently();
    addMessage("system", "Guidance stopped.");
  }, [addMessage, stopGuidanceSilently]);

  const handleResumeGuide = useCallback(async () => {
    const resumed = await sessionManager.resumeSession();
    if (!resumed) {
      return;
    }

    setSession(resumed);
    setRetryCount(0);
    addMessage("system", "Resuming guidance...");

    const pendingStep = sessionManager.getLastPendingStep(resumed);
    if (pendingStep) {
      const element = await highlighter.highlightStep(pendingStep);
      if (element) {
        attachClickHandlersRef.current(element);
        return;
      }
    }

    await requestNextStep(resumed);
  }, [addMessage, requestNextStep]);

  const handleOnboardingComplete = useCallback(async () => {
    await refreshConfiguration();
    clearRecoveryMessage();
    setOnboardingInitialStep("welcome");
    setPanelView("chat");
    setIsOpen(true);
    addMessage("system", "OpenRouter connected. You're ready to start guidance.");
  }, [addMessage, clearRecoveryMessage, refreshConfiguration]);

  const handleDisconnect = useCallback(async () => {
    setSettingsBusy(true);
    try {
      await stopGuidanceSilently();
      await disconnect();
      clearRecoveryMessage();
      setAvailableModels([]);
      setSelectedModelId("");
      setModelError(null);
      setOnboardingInitialStep("welcome");
      setPanelView("onboarding");
      setIsOpen(true);
    } finally {
      setSettingsBusy(false);
    }
  }, [clearRecoveryMessage, disconnect, stopGuidanceSilently]);

  const openModelSettings = useCallback(async () => {
    setPanelView("model");
    setIsLoadingModels(true);
    setModelError(null);

    try {
      const response = await sendRuntimeMessage<RuntimeResult<OpenRouterModel[]>>({
        type: MessageType.LIST_OPENROUTER_MODELS,
      });

      if (!response.success || !response.data) {
        if (response.error?.code === "auth_invalidated") {
          await handleConfigurationInvalidation(response.error.message);
          return;
        }

        throw new Error(response.error?.message ?? "Unable to load models.");
      }

      setAvailableModels(response.data);
      setSelectedModelId(
        configurationStatus?.selectedModel ?? response.data[0]?.id ?? "",
      );
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "Unable to load models.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [configurationStatus?.selectedModel, handleConfigurationInvalidation]);

  const handleSaveSelectedModel = useCallback(async () => {
    if (!selectedModelId) {
      setModelError("Please choose a model to continue.");
      return;
    }

    setSettingsBusy(true);
    setModelError(null);
    try {
      await saveSelectedModel(selectedModelId);
      await refreshConfiguration();
      setPanelView("settings");
    } finally {
      setSettingsBusy(false);
    }
  }, [refreshConfiguration, selectedModelId]);

  const handleKeyPress = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSendMessage();
      }
    },
    [handleSendMessage],
  );

  const isGuidanceActive = session?.status === "active";
  const isGuidancePaused = session?.status === "paused";
  const completedSteps = session?.steps.filter((step) => step.completedAt) ?? [];
  const hasMorePageSteps =
    pageSteps.length > 1 && pageStepIndex < pageSteps.length - 1;

  const showBackButton =
    configurationStatus?.isConfigured === true &&
    (panelView === "settings" || panelView === "model" || panelView === "onboarding");

  const renderChatView = () => (
    <>
      <div className="aws-nav-messages">
        {messages.map((message) => (
          <div key={message.id} className={`aws-nav-message ${message.type}`}>
            <div className="aws-nav-message-content">
              {message.type === "error" && (
                <AlertTriangle size={14} className="aws-nav-error-icon" />
              )}
              {message.content}
            </div>
            {message.retryAction && (
              <button
                className="aws-nav-retry-button"
                onClick={() => {
                  void (message.retryAction === "retry-step"
                    ? handleRetryStep()
                    : handleRetryFresh());
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
                : "Analyzing page and generating next step..."}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

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
                <div className="aws-nav-step-text">{step.instruction}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isGuidancePaused && session?.pausedStepInstruction && (
        <div className="aws-nav-paused-info">
          <div className="aws-nav-paused-label">Paused at:</div>
          <div className="aws-nav-paused-step">{session.pausedStepInstruction}</div>
        </div>
      )}

      <div className="aws-nav-controls">
        {(isGuidanceActive || isGuidancePaused) && (
          <div className="aws-nav-guide-controls">
            {hasMorePageSteps && isGuidanceActive && (
              <button
                className="aws-nav-button-next"
                onClick={() => {
                  void advanceToNextPageStep();
                }}
                disabled={isLoading}
              >
                Next <ChevronRight size={14} />
                <span className="aws-nav-step-counter">
                  {pageStepIndex + 1}/{pageSteps.length}
                </span>
              </button>
            )}
            {isGuidancePaused && (
              <button className="aws-nav-button-resume" onClick={() => void handleResumeGuide()}>
                Resume
              </button>
            )}
            <button className="aws-nav-button-stop" onClick={() => void handleStopGuide()}>
              <Square size={12} /> Stop
            </button>
          </div>
        )}

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
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyPress}
            disabled={isLoading}
          />
          <button
            className="aws-nav-send-button"
            onClick={() => void handleSendMessage()}
            disabled={!inputValue.trim() || isLoading}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </>
  );

  const renderModelView = () => (
    <div className="aws-nav-screen">
      <div className="aws-nav-settings">
        <div className="aws-nav-screen-header">
          <h2>Change Model</h2>
          <p>Select which OpenRouter model powers future guidance requests.</p>
        </div>

        {isLoadingModels ? (
          <div className="aws-nav-loading-screen">
            <Loader2 size={18} className="aws-nav-spinner" />
            <span>Fetching models...</span>
          </div>
        ) : (
          <>
            <ModelSelector
              models={availableModels}
              selectedModelId={selectedModelId}
              onSelect={setSelectedModelId}
            />
            {modelError && <div className="aws-nav-inline-error">{modelError}</div>}
            <div className="aws-nav-stack">
              <button
                type="button"
                className="aws-nav-primary-button"
                onClick={() => {
                  void handleSaveSelectedModel();
                }}
                disabled={settingsBusy}
              >
                {settingsBusy && <Loader2 size={14} className="aws-nav-spinner" />}
                Save Model
              </button>
              <button
                type="button"
                className="aws-nav-secondary-button"
                onClick={() => setPanelView("settings")}
                disabled={settingsBusy}
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const renderCurrentView = () => {
    if (isConfigurationLoading) {
      return (
        <div className="aws-nav-loading-screen">
          <Loader2 size={18} className="aws-nav-spinner" />
          <span>Loading configuration...</span>
        </div>
      );
    }

    if (!configurationStatus?.isConfigured || panelView === "onboarding") {
      return (
        <OnboardingView
          initialStep={onboardingInitialStep}
          recoveryMessage={recoveryMessage}
          onComplete={handleOnboardingComplete}
        />
      );
    }

    if (panelView === "settings") {
      return (
        <SettingsView
          isConnected={configurationStatus.isConfigured}
          currentModel={configurationStatus.selectedModel}
          isBusy={settingsBusy}
          onChangeApiKey={() => {
            clearRecoveryMessage();
            setOnboardingInitialStep("input");
            setPanelView("onboarding");
          }}
          onChangeModel={() => {
            void openModelSettings();
          }}
          onDisconnect={handleDisconnect}
        />
      );
    }

    if (panelView === "model") {
      return renderModelView();
    }

    return renderChatView();
  };

  return (
    <div className="aws-nav-assistant">
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

      {isOpen && (
        <div className={`aws-nav-container ${isMinimized ? "minimized" : ""}`}>
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
              {showBackButton && (
                <button
                  className="aws-nav-header-text-button"
                  onClick={() => {
                    if (panelView === "model" || panelView === "onboarding") {
                      setPanelView("settings");
                    } else {
                      setPanelView("chat");
                    }
                  }}
                  title="Back"
                >
                  Back
                </button>
              )}
              {configurationStatus?.isConfigured && panelView === "chat" && (
                <button onClick={() => setPanelView("settings")} title="Settings">
                  <Settings size={16} />
                </button>
              )}
              <button
                onClick={() => setIsMinimized((current) => !current)}
                title={isMinimized ? "Maximize" : "Minimize"}
              >
                {isMinimized ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              </button>
              <button onClick={() => setIsOpen(false)} title="Close">
                <X size={16} />
              </button>
            </div>
          </div>

          {!isMinimized && renderCurrentView()}
        </div>
      )}
    </div>
  );
};
