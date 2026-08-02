import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Trash2,
} from "lucide-react";
import {
  MessageType,
  type OpenRouterModel,
  type OpenRouterValidationResult,
  type RuntimeResult,
} from "@aws-nav/shared";
import { saveApiKey, saveSelectedModel } from "../../src/services/configStorage";
import { sendRuntimeMessage } from "../runtime";
import { ModelSelector } from "./ModelSelector";

type OnboardingStep = "welcome" | "input" | "model" | "success";

interface OnboardingViewProps {
  initialStep?: "welcome" | "input";
  recoveryMessage?: string | null;
  onComplete: () => Promise<void>;
}

export function OnboardingView({
  initialStep = "welcome",
  recoveryMessage,
  onComplete,
}: OnboardingViewProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyError, setApiKeyError] = useState<string | null>(recoveryMessage ?? null);
  const [isKeyVisible, setIsKeyVisible] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");

  useEffect(() => {
    setStep(initialStep);
  }, [initialStep]);

  useEffect(() => {
    setApiKeyError(recoveryMessage ?? null);
  }, [recoveryMessage]);

  const statusItems = useMemo(
    () => [
      {
        label: "API Key Verified",
        complete: step === "model" || step === "success",
      },
      {
        label: "Models Loaded",
        complete: step === "model" || step === "success",
      },
      {
        label: "Configuration Complete",
        complete: step === "success",
      },
    ],
    [step],
  );

  async function pasteFromClipboard(): Promise<void> {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText.trim()) {
        setApiKeyError("Clipboard is empty.");
        setStep("input");
        return;
      }

      setApiKey(clipboardText.trim());
      setApiKeyError(null);
      setStep("input");
    } catch {
      setApiKeyError(
        "Clipboard access was denied. Paste your API key manually instead.",
      );
      setStep("input");
    }
  }

  async function handleValidateKey(): Promise<void> {
    if (!apiKey.trim()) {
      setApiKeyError("Please enter an API key.");
      return;
    }

    setIsWorking(true);
    setApiKeyError(null);
    setLoadingMessage("Validating API key...");

    try {
      const response = await sendRuntimeMessage<
        RuntimeResult<OpenRouterValidationResult>
      >({
        type: MessageType.VALIDATE_OPENROUTER_KEY,
        payload: { apiKey: apiKey.trim() },
      });

      if (!response.success || !response.data) {
        setApiKeyError(
          response.error?.message ?? "Unable to verify your OpenRouter API key.",
        );
        return;
      }

      setLoadingMessage("Fetching models...");
      setModels(response.data.models);
      setSelectedModelId(response.data.suggestedModel);
      setStep("model");
    } finally {
      setLoadingMessage(null);
      setIsWorking(false);
    }
  }

  async function handleSaveConfiguration(): Promise<void> {
    if (!selectedModelId) {
      setApiKeyError("Please choose a model to continue.");
      return;
    }

    setIsWorking(true);
    setApiKeyError(null);
    setLoadingMessage("Saving configuration...");

    try {
      await saveApiKey(apiKey.trim());
      await saveSelectedModel(selectedModelId);
      setStep("success");
      setTimeout(() => {
        void onComplete();
      }, 900);
    } finally {
      setLoadingMessage(null);
      setIsWorking(false);
    }
  }

  return (
    <div className="aws-nav-screen">
      <div className="aws-nav-onboarding">
        <div className="aws-nav-screen-header">
          <h2>Welcome to AWS Navigation Assistant</h2>
          <p>
            This extension runs entirely on your own OpenRouter account.
          </p>
        </div>

        <div className="aws-nav-onboarding-copy">
          <div>Your API key stays on your device.</div>
          <div>No backend server.</div>
          <div>No prompt storage.</div>
          <div>No analytics.</div>
          <div>Requests go directly to OpenRouter.</div>
        </div>

        {step === "welcome" && (
          <div className="aws-nav-stack">
            <button
              type="button"
              className="aws-nav-primary-button"
              onClick={() =>
                window.open(
                  "https://openrouter.ai/settings/keys",
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              Create OpenRouter API Key <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className="aws-nav-secondary-button"
              onClick={() => {
                void pasteFromClipboard();
              }}
            >
              Paste from Clipboard
            </button>
            <button
              type="button"
              className="aws-nav-secondary-button"
              onClick={() => {
                setApiKeyError(recoveryMessage ?? null);
                setStep("input");
              }}
            >
              Paste Manually
            </button>
          </div>
        )}

        {(step === "input" || step === "model" || step === "success") && (
          <>
            <div className="aws-nav-form-block">
              <label className="aws-nav-field-label" htmlFor="aws-nav-api-key">
                OpenRouter API Key
              </label>
              <div className="aws-nav-secret-input">
                <input
                  id="aws-nav-api-key"
                  type={isKeyVisible ? "text" : "password"}
                  className="aws-nav-input"
                  placeholder="sk-or-v1-..."
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={isWorking || step === "success"}
                />
                <button
                  type="button"
                  className="aws-nav-icon-button"
                  onClick={() => setIsKeyVisible((current) => !current)}
                  disabled={isWorking}
                  title={isKeyVisible ? "Hide API key" : "Show API key"}
                >
                  {isKeyVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  className="aws-nav-icon-button"
                  onClick={() => {
                    void pasteFromClipboard();
                  }}
                  disabled={isWorking}
                  title="Paste API key"
                >
                  <ClipboardPaste size={14} />
                </button>
                <button
                  type="button"
                  className="aws-nav-icon-button"
                  onClick={() => setApiKey("")}
                  disabled={isWorking || !apiKey}
                  title="Clear API key"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {apiKeyError && <div className="aws-nav-inline-error">{apiKeyError}</div>}

            <div className="aws-nav-status-list">
              {statusItems.map((item) => (
                <div key={item.label} className="aws-nav-status-item">
                  <CheckCircle2
                    size={14}
                    className={item.complete ? "complete" : "pending"}
                  />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>

            {step === "input" && (
              <div className="aws-nav-stack">
                <button
                  type="button"
                  className="aws-nav-primary-button"
                  onClick={() => {
                    void handleValidateKey();
                  }}
                  disabled={isWorking}
                >
                  {isWorking && <Loader2 size={14} className="aws-nav-spinner" />}
                  Save &amp; Verify
                </button>
                <button
                  type="button"
                  className="aws-nav-secondary-button"
                  onClick={() => setStep("welcome")}
                  disabled={isWorking}
                >
                  Back
                </button>
              </div>
            )}

            {step === "model" && (
              <div className="aws-nav-stack">
                <ModelSelector
                  models={models}
                  selectedModelId={selectedModelId}
                  onSelect={setSelectedModelId}
                  disabled={isWorking}
                />
                <button
                  type="button"
                  className="aws-nav-primary-button"
                  onClick={() => {
                    void handleSaveConfiguration();
                  }}
                  disabled={isWorking}
                >
                  {isWorking && <Loader2 size={14} className="aws-nav-spinner" />}
                  Complete Setup
                </button>
              </div>
            )}

            {step === "success" && (
              <div className="aws-nav-success-panel">
                <CheckCircle2 size={18} />
                <div>Configuration Complete</div>
              </div>
            )}

            {loadingMessage && (
              <div className="aws-nav-loading-line">
                <Loader2 size={14} className="aws-nav-spinner" />
                <span>{loadingMessage}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
