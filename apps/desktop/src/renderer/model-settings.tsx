import type { FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export function ModelSettings({
  settings,
  busy,
  apiKey,
  onApiKeyChange,
  onSave,
}: {
  settings: SettingsView | undefined;
  busy: boolean;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onSave: (input: SettingsUpdate) => Promise<void>;
}) {
  const disabled = busy || !settings;
  const hasApiKey = settings?.hasApiKey;
  const credentialError = settings?.credentialError;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && settings && apiKey.trim()) void onSave({ apiKey });
  }
  return (
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
        <p className="secondary">
          {credentialError ? "Key status unavailable" : hasApiKey ? "Key saved" : "No key saved"}
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
              disabled={busy}
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
            ? "Keys are stored in macOS Keychain. Diagram requests go to OpenRouter while Scope is open."
            : "This development session keeps keys in memory. They are not saved to disk."}
        </p>
      )}
      {credentialError && <p role="alert">{credentialError}</p>}
    </>
  );
}
