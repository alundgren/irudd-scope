import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export function ProviderSettings({
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
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const statusRequest = useRef<Promise<SettingsView> | null>(null);
  useEffect(() => {
    if (!active) {
      setChecking(false);
      return;
    }
    let canceled = false;
    setChecking(true);
    setCheckError("");
    const pending = (statusRequest.current ??= window.scope.providerSettings());
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
  }, [active, attempt, onLoaded]);
  const disabled = busy || checking || !settings;
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
      <p className="secondary">Shared by diagram and voice generation.</p>
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
            ? "Scope accesses your key for generation, billing lookup, key changes, or when this section opens. Keys are stored in macOS Keychain."
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
  );
}
