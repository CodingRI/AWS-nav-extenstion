import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Minimize2, Maximize2, Send, Loader2, CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import type { NavigationStep, NavigationResponse } from "@aws-nav/shared";
import { highlighter } from './highlighter';
import './App.css';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface GuideState {
  active: boolean;
  steps: NavigationStep[];
  currentStep: number;
  completedSteps: Set<number>;
  summary: string;
}

// Backend API URL - adjust if needed
const API_BASE_URL = 'http://localhost:3000';

export const App: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'assistant',
      content: 'Hi! Ask me how to do something in AWS.',
      timestamp: Date.now(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [guideState, setGuideState] = useState<GuideState>({
    active: false,
    steps: [],
    currentStep: 0,
    completedSteps: new Set<number>(),
    summary: '',
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Listen for step completion and page navigation
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data.type === 'AWS_NAV_STEP_COMPLETED') {
        handleStepCompleted(event.data.stepNumber);
      } else if (event.data.type === 'AWS_NAV_PAGE_CHANGED') {
        handlePageChanged();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [guideState]);

  const addMessage = (type: 'user' | 'assistant', content: string) => {
    const newMessage: Message = {
      id: Date.now().toString(),
      type,
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, newMessage]);
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userQuery = inputValue.trim();
    addMessage('user', userQuery);
    setInputValue('');
    setIsLoading(true);

    try {
      console.log('[App] Sending request to backend:', `${API_BASE_URL}/api/navigate`);
      
      // Call backend API
      const response = await fetch(`${API_BASE_URL}/api/navigate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: userQuery,
          currentPage: window.location.href,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: NavigationResponse = await response.json();
      console.log('[App] Received response:', data);

      if (!data.success || !data.steps) {
        throw new Error('Invalid response from server');
      }

      let responseText = data.summary + '\n\n' + data.steps.length + ' steps found.';
      addMessage('assistant', responseText);

      setGuideState({
        active: false,
        steps: data.steps,
        currentStep: 0,
        completedSteps: new Set(),
        summary: data.summary,
      });
    } catch (err) {
      console.error('[App] Error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      addMessage('assistant', `❌ Connection failed: ${errorMessage}\n\nMake sure the backend is running on ${API_BASE_URL}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleStartGuide = async () => {
    if (guideState.steps.length === 0) return;

    setGuideState((prev) => ({ ...prev, active: true, currentStep: 0 }));
    
    // Highlight first step
    const success = await highlighter.highlightElement(guideState.steps[0]);
    
    if (!success) {
      addMessage('assistant', '⚠️ Couldn\'t find the first element. Try refreshing the page.');
    }
  };

  const handleStepCompleted = (stepNumber: number) => {
    console.log('[App] Step completed:', stepNumber);
    
    setGuideState((prev) => {
      const newCompleted = new Set(prev.completedSteps);
      newCompleted.add(stepNumber);
      
      const nextStep = stepNumber + 1;
      
      // If more steps, move to next
      if (nextStep < prev.steps.length) {
        // Highlight next step (will retry if page is still loading)
        setTimeout(async () => {
          const success = await highlighter.highlightElement(prev.steps[nextStep]);
          if (!success) {
            addMessage('assistant', '⚠️ Couldn\'t find element for next step. The page might have changed.');
          }
        }, 1000); // Wait for page navigation
        
        return {
          ...prev,
          currentStep: nextStep,
          completedSteps: newCompleted,
        };
      }
      
      // Guide completed
      highlighter.clearHighlights();
      addMessage('assistant', '🎉 All steps completed!');
      
      return {
        ...prev,
        active: false,
        completedSteps: newCompleted,
      };
    });
  };

  const handlePageChanged = () => {
    console.log('[App] Page changed, re-highlighting current step...');
    
    // Re-highlight current step after page navigation
    if (guideState.active && guideState.currentStep < guideState.steps.length) {
      setTimeout(async () => {
        const step = guideState.steps[guideState.currentStep];
        await highlighter.rehighlightCurrentStep(step);
      }, 1500); // Wait for new page to load
    }
  };

  const handleStopGuide = () => {
    highlighter.clearHighlights();
    setGuideState((prev) => ({ 
      ...prev, 
      active: false,
      currentStep: 0,
      completedSteps: new Set(),
    }));
    addMessage('assistant', 'Guide stopped.');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

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
        </button>
      )}

      {/* Main chat container */}
      {isOpen && (
        <div className={`aws-nav-container ${isMinimized ? 'minimized' : ''}`}>
          {/* Header */}
          <div className="aws-nav-header">
            <div className="aws-nav-header-title">
              <span>AWS Navigator</span>
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
              {/* Messages area - only if no active guide */}
              {!guideState.active && (
                <div className="aws-nav-messages">
                  {messages.map((message) => (
                    <div key={message.id} className={`aws-nav-message ${message.type}`}>
                      <div className="aws-nav-message-content">{message.content}</div>
                    </div>
                  ))}
                  {isLoading && (
                    <div className="aws-nav-message assistant">
                      <div className="aws-nav-message-content">
                        <Loader2 size={14} className="aws-nav-spinner" />
                        Thinking...
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              )}

              {/* Tree-based step guide */}
              {guideState.steps.length > 0 && (
                <div className="aws-nav-guide-panel">
                  {!guideState.active ? (
                    <div className="aws-nav-guide-start">
                      <button className="aws-nav-button-start" onClick={handleStartGuide}>
                        Start Guide
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="aws-nav-step-tree">
                        {guideState.steps.map((step, index) => {
                          const isCompleted = guideState.completedSteps.has(step.stepNumber);
                          const isCurrent = index === guideState.currentStep;

                          return (
                            <div
                              key={step.stepNumber}
                              className={`aws-nav-step-item ${
                                isCompleted ? 'completed' : isCurrent ? 'current' : 'pending'
                              }`}
                            >
                              <div className="aws-nav-step-icon">
                                {isCompleted ? (
                                  <CheckCircle2 size={18} />
                                ) : isCurrent ? (
                                  <Circle size={18} className="pulse" />
                                ) : (
                                  <Circle size={18} />
                                )}
                              </div>
                              <div className="aws-nav-step-content">
                                <div className="aws-nav-step-number">Step {step.stepNumber}</div>
                                <div className="aws-nav-step-text">{step.instruction}</div>
                              </div>
                              {index < guideState.steps.length - 1 && (
                                <div className="aws-nav-step-connector">
                                  <ArrowRight size={14} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                        
                        {/* Completion indicator */}
                        {guideState.completedSteps.size === guideState.steps.length && (
                          <div className="aws-nav-step-item completed">
                            <div className="aws-nav-step-icon">
                              <CheckCircle2 size={18} />
                            </div>
                            <div className="aws-nav-step-content">
                              <div className="aws-nav-step-text">Complete!</div>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="aws-nav-guide-controls">
                        <button className="aws-nav-button-stop" onClick={handleStopGuide}>
                          Stop Guide
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Input area - only show if no active guide */}
              {!guideState.active && (
                <div className="aws-nav-input-container">
                  <input
                    ref={inputRef}
                    type="text"
                    className="aws-nav-input"
                    placeholder="Ask how to do something..."
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
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};