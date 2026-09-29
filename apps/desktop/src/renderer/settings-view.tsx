import { useEffect, useRef, useState } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import type { Appearance } from "./appearance.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { InstallationSettings } from "./installation-settings.tsx";
import { RemoteSettings } from "./remote-settings.tsx";
import { ProviderSettings } from "./provider-settings.tsx";
import { matchingSettings, SettingsSection } from "./settings-section.tsx";

export function SettingsViewPanel({
  onSettingsChange,
  initialQuery = "",
}: {
  onSettingsChange: (settings: SettingsView) => void;
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
      onSettingsChange(value);
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
      onSettingsChange(saved);
      if (input.apiKey || input.removeApiKey) setApiKey("");
      setNotice("Settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
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
      {notice && (
        <div className="settings-notice">
          <p role="status">{notice}</p>
          {!settings && (
            <Button type="button" variant="secondary" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
      )}
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
          <Switch
            label="Diagram generation"
            checked={settings?.diagramGenerationEnabled ?? false}
            disabled={busy || !settings}
            describedBy="diagram-generation-description"
            onCheckedChange={(enabled) => void save({ diagramGenerationEnabled: enabled })}
          />
          <p className="secondary" id="diagram-generation-description">
            Create diagrams and edit them with the Scope diagram agent.
          </p>
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
        </SettingsSection>
        <SettingsSection id="voice" query={query}>
          <Switch
            label="Voice generation"
            checked={settings?.voiceGenerationEnabled ?? false}
            disabled={busy || !settings}
            describedBy="voice-generation-description"
            onCheckedChange={(enabled) => void save({ voiceGenerationEnabled: enabled })}
          />
          <p className="secondary" id="voice-generation-description">
            Coding agents use your shared OpenRouter key to generate narration audio. Turning this
            off blocks new generations. Submitted requests may still finish and incur a charge.
          </p>
          <dl className="provider-details">
            <div>
              <dt>Provider</dt>
              <dd>OpenRouter</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>Gemini 3.8 Flash TTS</dd>
            </div>
            <div>
              <dt>Voice</dt>
              <dd>Kore</dd>
            </div>
          </dl>
        </SettingsSection>
        <SettingsSection id="credentials" query={query}>
          {(active) => (
            <ProviderSettings
              active={active}
              settings={settings}
              busy={busy}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              onSave={save}
              onLoaded={setSettings}
            />
          )}
        </SettingsSection>
        <RemoteSettings query={query} />
        <InstallationSettings query={query} />
      </div>
    </>
  );
}
