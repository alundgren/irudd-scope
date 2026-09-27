import { useEffect, useState, type FormEvent } from "react";
import type { SettingsUpdate, SettingsView } from "../settings.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";

export function SettingsViewPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SettingsView>();
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.scope
      .settings()
      .then((value) => {
        setSettings(value);
      })
      .catch(() => setNotice("Could not load settings."));
  }, []);
  async function save(input: SettingsUpdate) {
    setBusy(true);
    setNotice("");
    try {
      setSettings(await window.scope.saveSettings(input));
      setApiKey("");
      setNotice("Settings saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save({
      ...(apiKey ? { apiKey } : {}),
      provider: "openrouter",
      model: "google/gemini-3.8-flash",
    });
  }
  return (
    <section className="settings-panel" aria-label="Settings">
      <div className="section-title">
        <h1>Settings</h1>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
      <form onSubmit={submit} className="settings-form">
        <h2>Diagram generation</h2>
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
            placeholder={settings?.hasApiKey ? "Key saved. Enter a replacement." : "Enter API key"}
          />
        </label>
        <div className="key-status">
          <span>{settings?.hasApiKey ? "Key saved" : "No key saved"}</span>
          {settings?.hasApiKey && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void save({ removeApiKey: true })}
            >
              Remove key
            </Button>
          )}
        </div>
        <p className="secondary">
          {settings?.keyStorage === "keychain"
            ? "Keys are protected by macOS Keychain. AI runs on this Mac while Scope is open."
            : "Linux development uses keys only for this session. They are not saved to disk."}
        </p>
        <Button type="submit" disabled={busy || !settings}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        {notice && <p role="status">{notice}</p>}
      </form>
    </section>
  );
}
