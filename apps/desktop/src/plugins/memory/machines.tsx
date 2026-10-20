import type { MemoryMachine, MemoryMachineStatus } from "@irudd-scope/protocol/memory";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useMemory } from "../../renderer/memory-state.ts";
import { time } from "./format.ts";

const PHASES = {
  off: "Sync is off",
  waiting: "Waiting to sync",
  syncing: "Syncing",
  synced: "Last sync succeeded",
  error: "Sync error",
} as const;

function tooling(okf: MemoryMachineStatus["okf"]) {
  if (okf.installed) return `irudd-okf ${okf.version ?? "installed"}`;
  // No message means no tool check has been reported yet, so absence is not a finding.
  return okf.message ? "irudd-okf is not installed" : "Not checked";
}
function syncState(status: MemoryMachineStatus) {
  if (status.phase === "waiting" && status.repository === null)
    return "Local only (Git sync is off)";
  return PHASES[status.phase];
}

function Machine({ machine }: { machine: MemoryMachine }) {
  const status = machine.status;
  const name = machine.local ? `${machine.name} (this device)` : machine.name;
  // A remote message means the connection or relay is not current; any status is older.
  const stale = !machine.local && !!machine.message;
  if (!status)
    return (
      <li className="librarian-machine">
        <h3>
          {name} <span className="librarian-offline">· state unknown</span>
        </h3>
        <p>Current state unknown. Scope keeps no earlier observation.</p>
        {machine.message && <p className="librarian-note">{machine.message}</p>}
      </li>
    );
  const off = status.phase === "off";
  // Tooling messages also report routine upgrades, so only a missing tool counts, as in Settings.
  const attention =
    !off &&
    (status.phase === "error" ||
      (!status.okf.installed && !!status.okf.message) ||
      (status.bundle !== "registered" && !!status.bundleMessage) ||
      !!status.conflicts.length);
  return (
    <li className="librarian-machine">
      <h3>
        {name}{" "}
        {stale ? (
          <span className="librarian-offline">· details may be out of date</span>
        ) : (
          attention && <span className="librarian-attention">· needs attention</span>
        )}
      </h3>
      {stale && (
        <p>
          {machine.message} The details below were last observed this session and may have changed.
        </p>
      )}
      <dl className="librarian-facts">
        <dt>Memory sync</dt>
        <dd>
          {syncState(status)}
          {status.message && <p className="librarian-note">{status.message}</p>}
        </dd>
        {!off && (
          <>
            <dt>Last successful sync</dt>
            <dd>{status.lastSyncAt ? time(status.lastSyncAt) : "Not recorded"}</dd>
            <dt>Memory tooling</dt>
            <dd>
              {tooling(status.okf)}
              {status.okf.message && <p className="librarian-note">{status.okf.message}</p>}
            </dd>
            <dt>Library</dt>
            <dd>
              {status.bundle === "registered"
                ? "Registered as the personal library"
                : status.bundle === "name-taken"
                  ? "Another library uses the name personal"
                  : "Not registered"}
              {status.bundleMessage && <p className="librarian-note">{status.bundleMessage}</p>}
            </dd>
            <dt>Conflicts</dt>
            <dd>
              {status.conflicts.length ? (
                <ul className="memory-link-list" aria-label={`${machine.name} conflicts`}>
                  {status.conflicts.map((conflict) => (
                    <li key={conflict.url}>
                      <button
                        onClick={() =>
                          void window.scope.openMemoryLink(conflict.url).catch(() => {})
                        }
                      >
                        {conflict.title}
                      </button>
                      <small>{conflict.branch}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                "None reported"
              )}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

export function MachinesView({ onSettings }: { onSettings: () => void }) {
  const { status, error, setStatus, setError } = useMemory();
  return (
    <section className="librarian-machines" aria-label="Machines">
      <p className="librarian-note">
        You are browsing the personal library on this desktop. Last sync is a past observation, not
        proof that content matches.
      </p>
      <Button variant="secondary" onClick={onSettings}>
        Memory settings
      </Button>
      {error ? (
        <div role="alert" className="memory-error">
          <p>Could not read memory status.</p>
          <Button
            variant="secondary"
            onClick={() =>
              void window.scope
                .memory()
                .then((next) => {
                  setError("");
                  setStatus(next);
                })
                .catch(() => setError("Could not read memory status."))
            }
          >
            Retry
          </Button>
        </div>
      ) : !status ? (
        <p role="status">Reading memory status…</p>
      ) : (
        <>
          {(!status.configuration.repository || status.configuration.syncEnabled === false) && (
            <p>Git sync is off on this desktop.</p>
          )}
          <ul className="librarian-machine-list" aria-label="Memory by machine">
            {status.machines.map((machine) => (
              <Machine key={machine.id} machine={machine} />
            ))}
          </ul>
        </>
      )}
      <h3>Not available yet</h3>
      <ul className="librarian-unavailable">
        <li>Browsing another machine's memories</li>
        <li>Which machine recorded each change</li>
        <li>Whether two machines hold the same content</li>
        <li>Live sync progress and last contact time</li>
        <li>Observations of an unreachable machine after Scope restarts</li>
      </ul>
    </section>
  );
}
