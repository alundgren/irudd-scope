import { WorkspaceNavigationContext } from "../workspace/navigation-context.ts";
import { useContext, useEffect, useRef, useState } from "react";
import type { MemoryMachine, MemoryStatus } from "@irudd-scope/protocol/memory";
import { Button } from "./components/ui/button.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { SettingsSection } from "./settings-section.tsx";
import { useLibrarian } from "./librarian-state.ts";
import { useMemory } from "./memory-state.ts";

function machineSummary(machine: MemoryMachine) {
  const status = machine.status;
  const lines = [machine.message ?? status?.message ?? "Waiting for status."];
  if (status?.lastSyncAt) lines.push(`Last sync ${new Date(status.lastSyncAt).toLocaleString()}.`);
  if (status?.bundle !== "registered" && status?.bundleMessage) lines.push(status.bundleMessage);
  if (!status?.okf.installed && status?.okf.message) lines.push(status.okf.message);
  return [...new Set(lines)];
}

export function MemorySettings({ query }: { query: string }) {
  const navigation = useContext(WorkspaceNavigationContext);
  const { status, error, setStatus, setError } = useMemory();
  const librarian = useLibrarian();
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
      <p className="secondary">Choose your memory folder. Git sync is optional.</p>
      {navigation && (
        <Button
          variant="secondary"
          onClick={() =>
            void navigation
              .openMemoryTab()
              .catch(() => setError("Could not open Librarian. Retry."))
          }
        >
          Open Librarian
        </Button>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => run(() => window.scope.chooseMemoryFolder())}
      >
        Choose local folder
      </Button>
      {status?.configuration.localRoot && !repository && (
        <p>
          <code>{status.configuration.localRoot}</code>
        </p>
      )}
      <Switch
        label="Weekly dreaming reminder"
        checked={librarian.state?.reminder.enabled ?? true}
        disabled={!librarian.state}
        onCheckedChange={(enabled) => {
          if (!librarian.state) return;
          void window.scope
            .librarianHuman({
              action: "reminder",
              requestId: crypto.randomUUID(),
              expectedUiRevision: librarian.state.uiRevision,
              enabled,
              dismiss: false,
            })
            .then(librarian.setState)
            .catch(() => setError("Could not save the reminder setting. Retry."));
        }}
      />
      <Switch
        label="Memory"
        checked={enabled}
        disabled={busy || !status || (!enabled && !status.okfInstalled)}
        onCheckedChange={(next) => run(() => window.scope.setMemoryEnabled(next))}
      />
      <Switch
        label="Git sync"
        checked={enabled && !!repository && status?.configuration.syncEnabled !== false}
        disabled={busy || !repository}
        onCheckedChange={(next) => run(() => window.scope.setMemorySyncEnabled(next))}
      />
      {window.scope.platform === "win32" && (
        <p className="secondary">
          Windows uses the native irudd-okf executable on PATH. Install or update it with the
          irudd-okf PowerShell installer. Scope keeps automatic upgrades off on Windows.
        </p>
      )}
      {window.scope.platform !== "win32" && status && !status.okfInstalled && !enabled && (
        <p className="secondary">
          Install irudd-okf on this device first:{" "}
          <code>
            curl -fsSL https://raw.githubusercontent.com/alundgren/irudd-okf/main/install.sh | bash
          </code>
        </p>
      )}
      {enabled && !repository && !status?.configuration.localRoot && !repository && (
        <div className="memory-setup">
          <p>Ask your coding agent to initialize a local memory folder and connect it to Scope.</p>
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
                <strong>{machine.local ? `${machine.name} (this device)` : machine.name}</strong>
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
  const librarian = useLibrarian();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [message, setMessage] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const conflicts = status?.conflicts.length ?? 0;
  if (!conflicts) {
    const state = librarian.state;
    if (
      !state ||
      !state.reminder.enabled ||
      now < Date.parse(state.reminder.dueAt) ||
      state.view === "decision"
    )
      return null;
    return (
      <div className="memory-notice" role="status">
        <span>Time to dream? Ask your coding agent when you are ready.</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void window.scope
              .librarianHuman({
                action: "reminder",
                requestId: crypto.randomUUID(),
                expectedUiRevision: state.uiRevision,
                dismiss: true,
              })
              .then(librarian.setState)
              .catch(() => setMessage("Could not dismiss the reminder. Retry."));
          }}
        >
          Dismiss reminder
        </Button>
        {message && <span>{message}</span>}
      </div>
    );
  }
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
