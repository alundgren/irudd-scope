import { useEffect, useState, type FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import type { Appearance } from "./appearance.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";

export const settingsSections = [
  { id: "appearance", title: "Appearance", terms: "theme system light dark colors" },
  {
    id: "model",
    title: "Diagram generation",
    terms: "provider model openrouter gemini api key credentials",
  },
];
export function matchingSettings(query: string) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return settingsSections.filter((section) =>
    words.every((word) => `${section.title} ${section.terms}`.toLowerCase().includes(word)),
  );
}

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
  const matches = matchingSettings(query);
  const visible = (id: string) => matches.some((section) => section.id === id);
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
    void save(apiKey ? { apiKey } : {});
  }
  return (
    <>
      <Input
        type="search"
        aria-label="Search settings"
        placeholder="Search settings…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      {matches.length === 0 && (
        <div role="status">
          <p>No settings match "{query}".</p>
          <Button variant="ghost" onClick={() => setQuery("")}>
            Clear search
          </Button>
        </div>
      )}
      <form onSubmit={submit} className="settings-form">
        <fieldset hidden={!visible("appearance")}>
          <legend>Appearance</legend>
          <label>
            Color scheme
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
        </fieldset>
        <fieldset hidden={!visible("model")}>
          <legend>Diagram generation</legend>
          <label>
            Provider
            <NativeSelect aria-label="Provider" defaultValue="openrouter">
              <NativeSelectOption value="openrouter">OpenRouter</NativeSelectOption>
            </NativeSelect>
          </label>
          <label>
            Model
            <NativeSelect aria-label="Model" defaultValue="google/gemini-3.8-flash">
              <NativeSelectOption value="google/gemini-3.8-flash">
                Gemini 3.8 Flash
              </NativeSelectOption>
            </NativeSelect>
          </label>
          <label>
            OpenRouter API key
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
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
          <div className="key-status">
            <span>
              {settings?.credentialError
                ? "Key status unavailable"
                : settings?.hasApiKey
                  ? "Key saved"
                  : "No key saved"}
            </span>
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
          {settings && (
            <p className="secondary">
              {settings.keyStorage === "keychain"
                ? "Keys are stored in macOS Keychain. Diagram requests go to OpenRouter while Scope is open."
                : "This development session keeps keys in memory. They are not saved to disk."}
            </p>
          )}
          {settings?.credentialError && <p role="alert">{settings.credentialError}</p>}
        </fieldset>
        <div className="section-title">
          <Button type="submit" disabled={busy || !settings}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Done
          </Button>
        </div>
        {notice && <p role="status">{notice}</p>}
        {!settings && notice && (
          <Button type="button" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        )}
      </form>
    </>
  );
}
