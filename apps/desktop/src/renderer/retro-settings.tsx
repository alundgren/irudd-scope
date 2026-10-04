import { useEffect, useState } from "react";
import type { RetroConfiguration, RetroRuntime } from "@irudd-scope/protocol/retro";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { SettingsSection } from "./settings-section.tsx";
import { RetroHistory } from "./retro-history.tsx";
import { retroError } from "./retro-error.ts";

type Source = RetroConfiguration["sources"][number];
const destinationLabel = {
  instructions: "Instructions and rules",
  "claude-memory": "Claude memory",
  "codex-instructions": "Codex instructions",
  file: "File",
  issue: "Issue",
  okf: "irudd-okf",
};
export function RetroSettings({ query }: { query: string }) {
  const [configuration, setConfiguration] = useState<RetroConfiguration>();
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setConfiguration(await window.scope.retroConfiguration());
      setDirty(false);
      setNotice("");
    } catch (failure) {
      setError(retroError(failure, "Could not read RETRO settings."));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function change(value: RetroConfiguration) {
    setConfiguration(value);
    setDirty(true);
    setNotice("");
  }
  async function save() {
    if (!configuration) return;
    setBusy(true);
    setError("");
    try {
      const saved = await window.scope.saveRetroConfiguration({
        requestId: crypto.randomUUID(),
        expectedVersion: configuration.version,
        configuration,
      });
      setConfiguration(saved);
      setDirty(false);
      setNotice("RETRO settings saved.");
    } catch (failure) {
      setError(
        `${retroError(failure, "Could not save RETRO settings.")} Your edits are kept. Retry, or reload the saved settings to discard them.`,
      );
    } finally {
      setBusy(false);
    }
  }
  function updateSource(id: string, update: Partial<Source>) {
    if (configuration)
      change({
        ...configuration,
        sources: configuration.sources.map((source) =>
          source.id === id ? { ...source, ...update } : source,
        ),
      });
  }
  return (
    <SettingsSection id="retros" query={query}>
      <p className="secondary">
        Your coding agent reviews sessions from these sources using its local or SSH access. Ask it
        for a Scope retro when you are ready.
      </p>
      <Button type="button" variant="secondary" onClick={() => setHistory(true)}>
        Open RETRO history
      </Button>
      {!configuration && !error && <p role="status">Loading RETRO settings…</p>}
      {configuration && (
        <>
          <h3>Session sources</h3>
          {configuration.sources.length === 0 && (
            <p className="secondary">
              No sources configured. Add your Mac or an SSH source, or ask your coding agent to
              configure them.
            </p>
          )}
          {configuration.sources.map((source) => (
            <fieldset className="retro-source" key={source.id} disabled={busy}>
              <legend>{source.name || "New source"}</legend>
              <label>
                Source name
                <Input
                  value={source.name}
                  maxLength={512}
                  onChange={(event) => updateSource(source.id, { name: event.target.value })}
                />
              </label>
              <div className="retro-source-location">
                <label>
                  Access
                  <NativeSelect
                    aria-label="Access"
                    value={source.sshAlias === null ? "local" : "ssh"}
                    onChange={(event) =>
                      updateSource(source.id, {
                        sshAlias: event.target.value === "local" ? null : "",
                      })
                    }
                  >
                    <NativeSelectOption value="local">Local machine</NativeSelectOption>
                    <NativeSelectOption value="ssh">SSH alias</NativeSelectOption>
                  </NativeSelect>
                </label>
                {source.sshAlias !== null && (
                  <label>
                    SSH alias
                    <Input
                      value={source.sshAlias}
                      placeholder="dev-box"
                      spellCheck={false}
                      onChange={(event) =>
                        updateSource(source.id, { sshAlias: event.target.value })
                      }
                    />
                  </label>
                )}
              </div>
              <Switch
                label={`Include ${source.name || "source"}`}
                checked={source.included}
                onCheckedChange={(included) => updateSource(source.id, { included })}
              />
              <div className="retro-runtime-choices">
                {(["codex", "claude"] as const).map((runtime) => (
                  <Switch
                    key={runtime}
                    label={runtime === "codex" ? "Codex sessions" : "Claude sessions"}
                    checked={source.runtimes.includes(runtime)}
                    onCheckedChange={(checked) =>
                      updateSource(source.id, {
                        runtimes: checked
                          ? [...source.runtimes, runtime]
                          : source.runtimes.filter((value: RetroRuntime) => value !== runtime),
                      })
                    }
                  />
                ))}
              </div>
              <details>
                <summary>Runtime directories</summary>
                <p className="secondary">
                  Leave blank for the runtime's usual directory on this source.
                </p>
                {(["codex", "claude"] as const).map((runtime) => (
                  <label key={runtime}>
                    {runtime === "codex" ? "Codex root" : "Claude root"}
                    <Input
                      value={source.runtimeRoots[runtime] ?? ""}
                      spellCheck={false}
                      placeholder={runtime === "codex" ? "~/.codex" : "~/.claude"}
                      onChange={(event) =>
                        updateSource(source.id, {
                          runtimeRoots: {
                            ...source.runtimeRoots,
                            [runtime]: event.target.value || null,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </details>
              <Button
                type="button"
                variant="ghost"
                className="retro-remove"
                onClick={() =>
                  change({
                    ...configuration,
                    sources: configuration.sources.filter((entry) => entry.id !== source.id),
                  })
                }
              >
                Remove source
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              change({
                ...configuration,
                sources: [
                  ...configuration.sources,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    sshAlias: null,
                    included: true,
                    runtimes: ["codex", "claude"],
                    runtimeRoots: { codex: null, claude: null },
                  },
                ],
              })
            }
          >
            Add source
          </Button>
          <p className="secondary">
            SSH uses your usual alias and credentials. Scope hub pairings are separate. Your agent
            asks whether to include existing history when it first discovers a source.
          </p>
          <h3>Repository choices</h3>
          <p className="secondary">
            Choices follow the canonical Git origin across sources and worktrees. Your agent asks
            about newly found repositories.
          </p>
          {configuration.repositories.length === 0 && (
            <p className="secondary">No repository choices yet.</p>
          )}
          {configuration.repositories.map((repository) => (
            <div className="retro-repository" key={repository.repository}>
              <span>{repository.repository}</span>
              <NativeSelect
                aria-label={`Review ${repository.repository}`}
                disabled={busy}
                value={repository.included ? "include" : "exclude"}
                onChange={(event) =>
                  change({
                    ...configuration,
                    repositories: configuration.repositories.map((entry) =>
                      entry.repository === repository.repository
                        ? { ...entry, included: event.target.value === "include" }
                        : entry,
                    ),
                  })
                }
              >
                <NativeSelectOption value="include">Include</NativeSelectOption>
                <NativeSelectOption value="exclude">Exclude</NativeSelectOption>
              </NativeSelect>
            </div>
          ))}
          <h3>Optional memory</h3>
          <Switch
            label="Memory suggestions"
            checked={configuration.memory.enabled}
            disabled={busy}
            onCheckedChange={(enabled) =>
              change({ ...configuration, memory: { ...configuration.memory, enabled } })
            }
          />
          <p className="secondary">
            Off by default. General corrections remain available. This setting does not change the
            runtime's own memory controls.
          </p>
          {configuration.memory.enabled && (
            <>
              <p className="secondary">
                Ask your agent to verify an instructions file or Claude memory directory before
                adding a permitted destination. Codex instructions are editable; its generated
                native memory uses the runtime's own controls. irudd-okf appears only after its CLI
                is detected on the destination source.
              </p>
              {configuration.memory.destinations
                .filter((destination) => destination.type !== "okf" || destination.available)
                .map((destination) => (
                  <div className="retro-memory-destination" key={destination.id}>
                    <div>
                      <strong>{destinationLabel[destination.type]}</strong>
                      <p>
                        {destination.scope === "operator" ? "Personal" : "Project"} ·{" "}
                        {configuration.sources.find((source) => source.id === destination.sourceId)
                          ?.name ?? destination.sourceId}
                      </p>
                      <p className="secondary">{destination.path}</p>
                      {!destination.available && (
                        <p role="status">Unavailable. Ask the agent to check this destination.</p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        change({
                          ...configuration,
                          memory: {
                            ...configuration.memory,
                            destinations: configuration.memory.destinations.filter(
                              (entry) => entry.id !== destination.id,
                            ),
                          },
                        })
                      }
                    >
                      Remove destination
                    </Button>
                  </div>
                ))}
              {configuration.memory.destinations.filter(
                (destination) => destination.type !== "okf" || destination.available,
              ).length === 0 && (
                <p className="secondary">
                  No permitted destinations. The agent can still propose general corrections.
                </p>
              )}
            </>
          )}
          <Button
            type="button"
            disabled={
              busy ||
              !dirty ||
              configuration.sources.some(
                (source) =>
                  !source.name.trim() || (source.sshAlias !== null && !source.sshAlias.trim()),
              )
            }
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save RETRO settings"}
          </Button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void load()}>
            {dirty ? "Reload saved settings" : "Retry"}
          </Button>
        </div>
      )}
      <RetroHistory open={history} onOpenChange={setHistory} />
    </SettingsSection>
  );
}
