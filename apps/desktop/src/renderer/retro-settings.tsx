import { useEffect, useState } from "react";
import type { RetroConfiguration, RetroRuntime } from "@irudd-scope/protocol/retro";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { SettingsSection } from "./settings-section.tsx";
import { RetroHistory } from "./retro-history.tsx";
import { retroError } from "./retro-error.ts";
import { isPersonalMemoryDestination } from "../memory-contract.ts";
import { useMemory } from "./memory-settings.tsx";

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
  const { status: memoryStatus } = useMemory();
  const okfEnabled = memoryStatus?.configuration.enabled ?? false;
  const [configuration, setConfiguration] = useState<RetroConfiguration>();
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [machinesChanged, setMachinesChanged] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      setConfiguration(await window.scope.retroConfiguration());
      setDirty(false);
      setNotice("");
      setMachinesChanged(false);
    } catch (failure) {
      setError(retroError(failure, "Could not read retrospective settings."));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    let request = 0;
    let active = true;
    const unsubscribe = window.scope.onMemoryChange(() => {
      const id = ++request;
      void window.scope
        .retroConfiguration()
        .then((next) => {
          if (!active || id !== request) return;
          setConfiguration((current) =>
            current
              ? {
                  ...current,
                  memory: {
                    ...current.memory,
                    destinations: [
                      ...current.memory.destinations.filter(
                        (destination) =>
                          !isPersonalMemoryDestination(destination) &&
                          (dirty || destination.type !== "okf"),
                      ),
                      ...next.memory.destinations.filter(
                        (destination) =>
                          destination.type === "okf" &&
                          (!dirty || isPersonalMemoryDestination(destination)) &&
                          current.sources.some((source) => source.id === destination.sourceId),
                      ),
                    ],
                  },
                }
              : next,
          );
        })
        .catch((failure: unknown) => {
          if (active && id === request)
            setError(retroError(failure, "Could not refresh retrospective memory destinations."));
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [dirty]);
  useEffect(
    () =>
      window.scope.onRemotesChange((remotes) => {
        if (!configuration) return;
        const known = configuration.sources.filter((source) => source.location?.type === "remote");
        if (
          known.length === remotes.length &&
          remotes.every((remote) =>
            known.some(
              (source) =>
                source.location?.type === "remote" &&
                source.location.remoteId === remote.id &&
                source.location.endpoint === remote.endpoint &&
                source.name === remote.name,
            ),
          )
        )
          return;
        if (dirty) {
          setMachinesChanged(true);
          setNotice(
            "Paired remotes changed. Reload saved settings to refresh the machine list. Your edits are kept until you reload.",
          );
        } else void load();
      }),
    [configuration, dirty],
  );
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
      setNotice("Retrospective settings saved.");
    } catch (failure) {
      setError(
        `${retroError(failure, "Could not save retrospective settings.")} Your edits are kept. Retry, or reload the saved settings to discard them.`,
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
        Your coding agent reviews sessions on this machine and your paired remotes. Ask it for a
        Scope retro when you are ready.
      </p>
      <Button type="button" variant="secondary" onClick={() => setHistory(true)}>
        Open retrospective history
      </Button>
      {!configuration && !error && <p role="status">Loading retrospective settings…</p>}
      {configuration && (
        <>
          <h3>Session locations</h3>
          <p className="secondary">
            This machine and your paired remotes appear automatically. Manage remotes in Remotes
            settings.
          </p>
          {configuration.sources.map((source) => (
            <fieldset className="retro-source" key={source.id} disabled={busy}>
              <legend>{source.name}</legend>
              <p className="secondary">
                {source.location?.type === "desktop"
                  ? source.location.hostname
                  : source.location?.type === "remote"
                    ? source.location.endpoint
                    : source.name}
              </p>
              <Switch
                label={`Include ${source.name}`}
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
                  Leave blank for the runtime's usual directory on this machine.
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
            </fieldset>
          ))}
          <p className="secondary">
            Your agent uses its existing access to each machine and reports any it cannot reach. It
            asks whether to include existing history the first time it reviews a machine.
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
                native memory uses the runtime's own controls. Turn on Memory sync to use a synced
                irudd-okf personal bundle.
              </p>
              {configuration.memory.destinations
                .filter(
                  (destination) =>
                    destination.type !== "okf" || (okfEnabled && destination.available),
                )
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
                    {!isPersonalMemoryDestination(destination) && (
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
                    )}
                  </div>
                ))}
              {configuration.memory.destinations.filter(
                (destination) =>
                  destination.type !== "okf" || (okfEnabled && destination.available),
              ).length === 0 && (
                <p className="secondary">
                  No permitted destinations. The agent can still propose general corrections.
                </p>
              )}
            </>
          )}
          <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {machinesChanged && !error && (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void load()}>
          Reload saved settings
        </Button>
      )}
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
