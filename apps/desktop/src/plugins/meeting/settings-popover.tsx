import { useEffect, useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Settings2 } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import { operationError } from "../../renderer/operation-error.ts";
import {
  CODEX_EFFORT,
  CODEX_MODEL,
  CODEX_SERVICE_TIER,
  type MeetingSettings,
  OPENROUTER_EDIT_MODELS,
  TRANSCRIPTION_MODEL,
} from "./contract.ts";

export type CodexLookup =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "found"; path: string }
  | { state: "missing"; error: string };

export function useCodexLookup(override: string, wanted: boolean) {
  const [lookup, setLookup] = useState<CodexLookup>({ state: "idle" });
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    setLookup({ state: "checking" });
    window.scope.meetingCodexStatus(override).then(
      (status) => {
        if (!current) return;
        setLookup(
          status.path
            ? { state: "found", path: status.path }
            : { state: "missing", error: status.error ?? "Codex was not found." },
        );
      },
      (cause: unknown) => {
        if (current) setLookup({ state: "missing", error: operationError(cause) });
      },
    );
    return () => {
      current = false;
    };
  }, [override, wanted]);
  return lookup;
}

export function SettingsPopover({
  settings,
  codex,
  onChange,
}: {
  settings: MeetingSettings;
  codex: CodexLookup;
  onChange: (patch: Partial<MeetingSettings>) => void;
}) {
  const id = useId();
  const [path, setPath] = useState(settings.codexPath);
  const [language, setLanguage] = useState(settings.language);
  useEffect(() => setPath(settings.codexPath), [settings.codexPath]);
  useEffect(() => setLanguage(settings.language), [settings.language]);
  const models: readonly string[] = OPENROUTER_EDIT_MODELS.includes(
    settings.openrouterModel as (typeof OPENROUTER_EDIT_MODELS)[number],
  )
    ? OPENROUTER_EDIT_MODELS
    : [settings.openrouterModel, ...OPENROUTER_EDIT_MODELS];
  const showPath = codex.state === "missing" || settings.codexPath !== "";
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button variant="ghost" size="icon" aria-label="Meeting canvas settings" />}
        title="Meeting canvas settings"
      >
        <Settings2 />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="mc-settings">
            <Popover.Title className="mc-settings-title">Meeting canvas settings</Popover.Title>
            <label htmlFor={`${id}-model`}>OpenRouter edit model</label>
            <NativeSelect
              id={`${id}-model`}
              value={settings.openrouterModel}
              onChange={(event) => onChange({ openrouterModel: event.target.value })}
            >
              {models.map((model) => (
                <NativeSelectOption key={model} value={model}>
                  {model}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <label htmlFor={`${id}-language`}>Spoken language</label>
            <Input
              id={`${id}-language`}
              placeholder="Automatic"
              maxLength={8}
              value={language}
              aria-describedby={`${id}-language-help`}
              onChange={(event) => setLanguage(event.target.value)}
              onBlur={() => {
                const code = language.trim().toLowerCase();
                if (code !== settings.language) onChange({ language: code });
              }}
            />
            <p id={`${id}-language-help`} className="mc-muted">
              A code such as en or sv. Leave empty to detect it.
            </p>
            <dl className="mc-settings-facts">
              <dt>Transcription</dt>
              <dd>{TRANSCRIPTION_MODEL}</dd>
              <dt>Codex model</dt>
              <dd>
                {CODEX_MODEL}, {CODEX_EFFORT} effort, {CODEX_SERVICE_TIER} tier
              </dd>
              <dt>Codex program</dt>
              <dd>
                {codex.state === "idle"
                  ? "Found when Codex is the backend"
                  : codex.state === "checking"
                    ? "Looking for codex…"
                    : codex.state === "found"
                      ? codex.path
                      : codex.error}
              </dd>
            </dl>
            {showPath && (
              <form
                className="mc-settings-path"
                onSubmit={(event) => {
                  event.preventDefault();
                  onChange({ codexPath: path.trim() });
                }}
              >
                <label htmlFor={`${id}-codex`}>Path to codex</label>
                <div>
                  <Input
                    id={`${id}-codex`}
                    placeholder="/opt/homebrew/bin/codex"
                    maxLength={1024}
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                  />
                  <Button type="submit" variant="outline">
                    Check
                  </Button>
                </div>
              </form>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
