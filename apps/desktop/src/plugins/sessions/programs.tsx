import { Fragment, useMemo } from "react";
import type { SessionCall } from "@irudd-scope/sessions/contract";
import { byProgram, type ProgramGroup } from "@irudd-scope/sessions/groups";
import { count, duration } from "./model.ts";
import { Bar, byModel, ExpandRow, Stats, Toggle, useOpen } from "./parts.tsx";

export function Programs({
  calls,
  showAll,
}: {
  calls: SessionCall[];
  showAll: (label: string, calls: SessionCall[]) => void;
}) {
  const groups = useMemo(() => byProgram(calls), [calls]);
  const [open, toggle] = useOpen();
  const total = groups.reduce((sum, group) => sum + group.durationMs, 0);
  const shell = groups.reduce((sum, group) => sum + group.calls.length, 0);
  const other = groups.find((group) => group.program === null);
  const max = Math.max(0, ...groups.map((group) => group.durationMs));
  if (!shell) return <p className="sessions-empty">No shell calls in this view.</p>;
  return (
    <>
      <Stats
        items={[
          [duration(total), "Shell time (calls can overlap)"],
          [count(shell), "Shell calls"],
          [count(groups.length - (other ? 1 : 0)), "Programs"],
          [
            `${total ? ((100 * (other?.durationMs ?? 0)) / total).toFixed(1) : "0.0"}%`,
            `Time not matched to a program (${count(other?.calls.length ?? 0)} calls)`,
            "warn",
          ],
        ]}
      />
      <div className="sessions-card">
        <table className="sessions-table sessions-grouped">
          <thead>
            <tr>
              <th />
              <th>Program</th>
              <th className="num">Calls</th>
              <th>Total</th>
              <th className="num">Average</th>
              <th className="num">Slowest</th>
              <th className="num">Failed</th>
              <th className="num" title="Output shows 10 or more Compiling lines">
                Cold builds
              </th>
              <th className="num" title="Output shows Blocking waiting for file lock">
                Lock waits
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const name = group.program ?? "Not matched to a program";
              const key = name;
              return (
                <Fragment key={key}>
                  <ExpandRow
                    label={name}
                    open={open.has(key)}
                    onToggle={() => toggle(key)}
                    className={group.program === null ? "sessions-leftover" : ""}
                  >
                    <Toggle open={open.has(key)} />
                    <td className={group.program === null ? "" : "sessions-mono"}>{name}</td>
                    <td className="num">{count(group.calls.length)}</td>
                    <td>
                      <Bar value={group.durationMs} max={max} label={duration(group.durationMs)} />
                    </td>
                    <td className="num">{duration(group.durationMs / group.calls.length)}</td>
                    <td className="num">{duration(group.slowestMs)}</td>
                    <td className={`num ${group.failed ? "sessions-failed" : "sessions-muted"}`}>
                      {group.failed}
                    </td>
                    <td className={`num ${group.coldBuilds ? "" : "sessions-muted"}`}>
                      {group.coldBuilds}
                    </td>
                    <td className={`num ${group.lockWaits ? "" : "sessions-muted"}`}>
                      {group.lockWaits}
                    </td>
                  </ExpandRow>
                  {open.has(key) && (
                    <tr className="sessions-detail">
                      <td />
                      <td colSpan={8}>
                        <ProgramDetail
                          group={group}
                          showAll={() => showAll(`Program: ${name}`, group.calls)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sessions-note">
        Cold builds and lock waits are read from output kept at 2 KB on each end, so they are lower
        bounds.
      </p>
    </>
  );
}

function ProgramDetail({ group, showAll }: { group: ProgramGroup; showAll: () => void }) {
  const slowest = [...group.calls]
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 3);
  return (
    <div className="sessions-split">
      <div>
        <div className="sessions-h">By model</div>
        <table className="sessions-inner">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Calls</th>
              <th className="num">Total</th>
              <th className="num">Average</th>
            </tr>
          </thead>
          <tbody>
            {byModel(group.calls).map(([model, entry]) => (
              <tr key={model}>
                <td>{model}</td>
                <td className="num">{entry.calls}</td>
                <td className="num">{duration(entry.ms)}</td>
                <td className="num">{duration(entry.ms / entry.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="sessions-h">Slowest calls (end of command text)</div>
        {slowest.map((call, index) => (
          <div key={index} className="sessions-example">
            <span className="sessions-example-time">{duration(call.durationMs)}</span>
            <code>…{call.input.slice(-220)}</code>
          </div>
        ))}
        <button type="button" className="sessions-link" onClick={showAll}>
          {group.calls.length === 1
            ? "Show this call →"
            : `Show all ${count(group.calls.length)} calls →`}
        </button>
      </div>
    </div>
  );
}
