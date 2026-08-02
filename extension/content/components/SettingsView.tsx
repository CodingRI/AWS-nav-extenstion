import { Loader2, PlugZap, RotateCcw, Unplug } from "lucide-react";

interface SettingsViewProps {
  isConnected: boolean;
  currentModel: string | null;
  isBusy?: boolean;
  onChangeApiKey: () => void;
  onChangeModel: () => void;
  onDisconnect: () => Promise<void>;
}

export function SettingsView({
  isConnected,
  currentModel,
  isBusy = false,
  onChangeApiKey,
  onChangeModel,
  onDisconnect,
}: SettingsViewProps) {
  return (
    <div className="aws-nav-screen">
      <div className="aws-nav-settings">
        <div className="aws-nav-screen-header">
          <h2>Settings</h2>
          <p>Manage your OpenRouter connection for this extension.</p>
        </div>

        <div className="aws-nav-settings-card">
          <div className="aws-nav-settings-row">
            <span>Connection Status</span>
            <span className={isConnected ? "connected" : "disconnected"}>
              {isConnected ? "Connected ✓" : "Not Connected"}
            </span>
          </div>

          <div className="aws-nav-settings-row">
            <span>Current Model</span>
            <span>{currentModel ?? "Not selected"}</span>
          </div>
        </div>

        <div className="aws-nav-stack">
          <button
            type="button"
            className="aws-nav-secondary-button"
            onClick={onChangeApiKey}
            disabled={isBusy}
          >
            <RotateCcw size={14} />
            Change API Key
          </button>
          <button
            type="button"
            className="aws-nav-secondary-button"
            onClick={onChangeModel}
            disabled={isBusy || !isConnected}
          >
            <PlugZap size={14} />
            Change Model
          </button>
          <button
            type="button"
            className="aws-nav-danger-button"
            onClick={() => {
              void onDisconnect();
            }}
            disabled={isBusy}
          >
            {isBusy ? <Loader2 size={14} className="aws-nav-spinner" /> : <Unplug size={14} />}
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
