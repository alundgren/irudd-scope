import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import type { Appearance } from "./appearance.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { InstallationSettings } from "./installation-settings.tsx";
import { RemoteSettings } from "./remote-settings.tsx";
import { matchingSettings, SettingsSection } from "./settings-section.tsx";

export function SettingsViewPanel({
  onClose,
  onAppearanceChange,
  initialQuery = "",
}: {
  onClose: () => void;
  onAppearanceChange: (appearance: Appearance) => void;
  initialQuery?: string;
}) {
  const [settings, setSettings] = useState<SettingsView>();
  const [query, setQuery] = useState(initialQuery);
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const matches = matchingSettings(query);
  async function load() {
    setNotice("");
    try {
      const value = await window.scope.settings();
      setSettings(value);
    } catch {
      setNotice("Could not load settings. Try again.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function save(input: SettingsUpdate) {
    setBusy(true);
    setNotice("");
    try {
      const saved = await window.scope.saveSettings(input);
      setSettings(saved);
      onAppearanceChange(saved.appearance);
      if (input.apiKey || input.removeApiKey) setApiKey("");
      setNotice("Settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && settings && apiKey.trim()) void save({ apiKey });
  }
  return (
    <>
      <div className="settings-search">
        <Input
          ref={searchInput}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setNotice("");
          }}
          autoFocus
        />
      </div>
      <div className="settings-sections">
        {matches.length === 0 && (
          <div className="settings-empty" role="status">
            <p>No settings match "{query}".</p>
            <Button
              variant="ghost"
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              Clear search
            </Button>
          </div>
        )}
        <SettingsSection id="appearance" query={query}>
          <label className="appearance-setting">
            <span>Color scheme</span>
            <NativeSelect
              aria-label="Appearance"
              value={settings?.appearance ?? "system"}
              disabled={busy || !settings}
              onChange={(event) => void save({ appearance: event.target.value as Appearance })}
            >
              <NativeSelectOption value="system">System</NativeSelectOption>
              <NativeSelectOption value="light">Light</NativeSelectOption>
              <NativeSelectOption value="dark">Dark</NativeSelectOption>
            </NativeSelect>
          </label>
          <p className="secondary">System follows your Mac's appearance.</p>
        </SettingsSection>
        <SettingsSection id="model" query={query}>
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
                disabled={busy || !settings}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  settings?.credentialError
                    ? "Key status unavailable"
                    : settings?.hasApiKey
                      ? "Key saved. Enter a replacement."
                      : "Enter API key"
                }
              />
            </label>
            <p className="secondary">
              {settings?.credentialError
                ? "Key status unavailable"
                : settings?.hasApiKey
                  ? "Key saved"
                  : "No key saved"}
            </p>
            <div className="installation-actions">
              <Button type="submit" disabled={busy || !settings || !apiKey.trim()}>
                {busy ? "Saving…" : "Save key"}
              </Button>
              {settings?.hasApiKey && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void save({ removeApiKey: true })}
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
          {settings?.credentialError && <p role="alert">{settings.credentialError}</p>}
        </SettingsSection>
        <RemoteSettings query={query} />
        <InstallationSettings query={query} />
      </div>
      <div className="settings-footer">
        <div>
          {notice && <p role="status">{notice}</p>}
          {!settings && notice && (
            <Button type="button" variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Done
        </Button>
      </div>
    </>
  );
}
