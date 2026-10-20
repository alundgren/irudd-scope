import type { MemoryMachine } from "@irudd-scope/protocol/memory";
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

function Machine({ machine }: { machine: MemoryMachine }) {
  const status = machine.status;
  const name = machine.local ? `${machine.name} (this device)` : machine.name;
  if (!status)
    return (
      <li className="librarian-machine">
        <h3>
          {name} <span className="librarian-attention">· needs attention</span>
        </h3>
        <p>Current state unknown. Scope keeps no earlier observation.</p>
        {machine.message && <p className="librarian-note">{machine.message}</p>}
      </li>
    );
  const tooling = status.okf.installed
    ? `irudd-okf ${status.okf.version ?? "installed"}`
    : "irudd-okf is not installed";
  const attention =
    status.phase === "error" ||
    !status.okf.installed ||
    !!status.okf.message ||
    status.bundle !== "registered" ||
    !!status.conflicts.length;
  return (
    <li className="librarian-machine">
      <h3>
        {name} {attention && <span className="librarian-attention">· needs attention</span>}
      </h3>
      <dl className="librarian-facts">
        <dt>Memory sync</dt>
        <dd>
          {PHASES[status.phase]}
          {status.message && <p className="librarian-note">{status.message}</p>}
        </dd>
        <dt>Last successful sync</dt>
        <dd>{status.lastSyncAt ? time(status.lastSyncAt) : "Not recorded"}</dd>
        <dt>Memory tooling</dt>
        <dd>
          {tooling}
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
                    onClick={() => void window.scope.openMemoryLink(conflict.url).catch(() => {})}
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
      </dl>
    </li>
  );
}

export function MachinesView({ onSettings }: { onSettings: () => void }) {
  const { status, error } = useMemory();
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
        <p role="alert">{error}</p>
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
        <li>Earlier observations of a machine that cannot be reached</li>
      </ul>
    </section>
  );
}
