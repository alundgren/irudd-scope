import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export function ModelSettings({
  active,
  settings,
  busy,
  apiKey,
  onApiKeyChange,
  onSave,
  onLoaded,
}: {
  active: boolean;
  settings: SettingsView | undefined;
  busy: boolean;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onSave: (input: SettingsUpdate) => Promise<void>;
  onLoaded: (settings: SettingsView) => void;
}) {
  const enabled = settings?.diagramGenerationEnabled ?? false;
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const statusRequest = useRef<Promise<SettingsView> | null>(null);
  useEffect(() => {
    if (!active || !enabled) {
      setChecking(false);
      return;
    }
    let canceled = false;
    setChecking(true);
    setCheckError("");
    const pending = (statusRequest.current ??= window.scope.diagramSettings());
    void pending
      .then(
        (value) => {
          if (!canceled) onLoaded(value);
        },
        () => {
          if (!canceled) setCheckError("Could not check the API key. Try again.");
        },
      )
      .finally(() => {
        if (statusRequest.current === pending) statusRequest.current = null;
        if (!canceled) setChecking(false);
      });
    return () => {
      canceled = true;
    };
  }, [active, enabled, attempt, onLoaded]);
  const disabled = busy || checking || !enabled;
  const hasApiKey = settings?.hasApiKey;
  const credentialError = checkError || settings?.credentialError;
  const keyStatus = checking
    ? "Checking key…"
    : credentialError
      ? "Key status unavailable"
      : hasApiKey === null || hasApiKey === undefined
        ? "Key status not checked"
        : hasApiKey
          ? "Key saved"
          : "No key saved";
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!disabled && apiKey.trim()) void onSave({ apiKey });
  }
  return (
    <>
      <div className="diagram-generation-setting">
        <span>Enable diagram generation</span>
        <Button
          type="button"
          role="switch"
          aria-label="Enable diagram generation"
          aria-checked={enabled}
          variant={enabled ? "default" : "secondary"}
          disabled={busy || !settings}
          onClick={() => void onSave({ diagramGenerationEnabled: !enabled })}
        >
          {enabled ? "On" : "Off"}
        </Button>
      </div>
      {!enabled ? (
        <p className="secondary">
          Turn on to create diagrams and edit them with the diagram agent.
        </p>
      ) : (
        <>
          <dl className="provider-details">
            <div>
              <dt>Provider</dt>
              <dd>OpenRouter</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>Gemini 3.8 Flash</dd>
            </div>
          </dl>
          <form onSubmit={submit} className="settings-key-form">
            <label>
              OpenRouter API key
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                placeholder={
                  credentialError
                    ? "Key status unavailable"
                    : hasApiKey
                      ? "Key saved. Enter a replacement."
                      : "Enter API key"
                }
              />
            </label>
            <p className="secondary" role="status">
              {keyStatus}
            </p>
            <div className="installation-actions">
              <Button type="submit" disabled={disabled || !apiKey.trim()}>
                {busy ? "Saving…" : "Save key"}
              </Button>
              {hasApiKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={disabled}
                  onClick={() => void onSave({ removeApiKey: true })}
                >
                  Remove key
                </Button>
              )}
            </div>
          </form>
          {settings && (
            <p className="secondary">
              {settings.keyStorage === "keychain"
                ? "Scope accesses your key when you use diagram generation or open this section while it is on. Keys are stored in macOS Keychain."
                : "This development session keeps keys in memory. They are not saved to disk."}
            </p>
          )}
          {credentialError && !checking && (
            <div>
              <p role="alert">{credentialError}</p>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry key access
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
