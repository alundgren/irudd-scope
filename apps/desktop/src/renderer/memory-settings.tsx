import { useEffect, useRef, useState } from "react";
import type { MemoryMachine, MemoryStatus } from "@irudd-scope/protocol/memory";
import { Button } from "./components/ui/button.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { SettingsSection } from "./settings-section.tsx";

export function useMemory() {
  const [status, setStatus] = useState<MemoryStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let observed = false;
    const unsubscribe = window.scope.onMemoryChange((next) => {
      observed = true;
      if (current) {
        setStatus(next);
        setError("");
      }
    });
    void window.scope
      .memory()
      .then((next) => {
        if (current && !observed) setStatus(next);
      })
      .catch(() => {
        if (current && !observed)
          setError("Could not read memory status. Close Settings and retry.");
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return { status, error, setStatus, setError };
}

function machineSummary(machine: MemoryMachine) {
  const status = machine.status;
  const lines = [machine.message ?? status?.message ?? "Waiting for status."];
  if (status?.lastSyncAt) lines.push(`Last sync ${new Date(status.lastSyncAt).toLocaleString()}.`);
  if (status?.bundle === "registered") lines.push("irudd-okf bundle personal is registered.");
  else if (status?.bundleMessage) lines.push(status.bundleMessage);
  if (status?.okf.message) lines.push(status.okf.message);
  return [...new Set(lines)];
}

export function MemorySettings({ query }: { query: string }) {
  const { status, error, setStatus, setError } = useMemory();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  function run(action: () => Promise<MemoryStatus | void>, done = "") {
    setBusy(true);
    setError("");
    setNotice("");
    void action()
      .then((next) => {
        if (next) setStatus(next);
        if (next && next.configuration.enabled && next.configuration.repository && done) {
          const incomplete = next.machines.some(
            (machine) => machine.message || machine.status?.phase !== "synced",
          );
          setNotice(
            incomplete
              ? "Sync needs attention. Check each machine's status."
              : next.conflicts.length
                ? "Memory synced. Conflict pull requests need attention."
                : done,
          );
        } else setNotice(done);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not update memory. Retry."),
      )
      .finally(() => setBusy(false));
  }
  const enabled = status?.configuration.enabled ?? false;
  const repository = status?.configuration.repository;
  return (
    <SettingsSection id="memory" query={query}>
      <p className="secondary">
        Keep a personal irudd-okf memory repository on GitHub in sync on this Mac and every paired
        remote. Scope commits and pushes only when memory files change.
      </p>
      <Switch
        label="Memory sync"
        checked={enabled}
        disabled={busy || !status || (!enabled && !status.okfInstalled)}
        onCheckedChange={(next) => run(() => window.scope.setMemoryEnabled(next))}
      />
      {status && !status.okfInstalled && !enabled && (
        <p className="secondary">
          Install irudd-okf on this Mac first:{" "}
          <code>
            curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-okf/main/install.sh | bash
          </code>
        </p>
      )}
      {enabled && !repository && (
        <div className="memory-setup">
          <p>
            No memory repository yet. Ask your coding agent to create one. It suggests a private
            personal-memory repository and waits for your approval.
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              run(() => window.scope.copyMemoryRequest("create"), "Agent request copied.")
            }
          >
            Copy agent request
          </Button>
        </div>
      )}
      {enabled && repository && (
        <>
          <p>
            Repository <code>{repository}</code>
          </p>
          <ul className="memory-machines" aria-label="Memory sync by machine">
            {status.machines.map((machine) => (
              <li key={machine.id} data-phase={machine.status?.phase ?? "unknown"}>
                <strong>{machine.local ? `${machine.name} (this Mac)` : machine.name}</strong>
                {machineSummary(machine).map((line) => (
                  <span key={line} className="secondary">
                    {line}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => run(() => window.scope.retryMemory(), "Memory synced.")}
          >
            {busy ? "Syncing…" : "Sync now"}
          </Button>
        </>
      )}
      {(error || notice) && <p role="status">{error || notice}</p>}
    </SettingsSection>
  );
}

export function MemoryNotice() {
  const { status } = useMemory();
  const [message, setMessage] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const conflicts = status?.conflicts.length ?? 0;
  if (!conflicts) return null;
  return (
    <div className="memory-notice" role="alert">
      <span>
        {message ||
          `Memory has ${conflicts} sync conflict${conflicts === 1 ? "" : "s"}. Ask your agent to resolve ${conflicts === 1 ? "it" : "them"}.`}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          void window.scope
            .copyMemoryRequest("conflicts")
            .then(() => {
              setMessage("Agent request copied. Paste it into your coding agent.");
              clearTimeout(copiedTimer.current);
              copiedTimer.current = setTimeout(() => setMessage(""), 6000);
            })
            .catch(() => setMessage("Could not copy the request. Try again."))
        }
      >
        Copy agent request
      </Button>
    </div>
  );
}
