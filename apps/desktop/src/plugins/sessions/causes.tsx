import { Fragment, useMemo } from "react";
import type { SessionCall } from "@irudd-scope/sessions/contract";
import { byCause, OTHER_CAUSE, type CauseGroup } from "@irudd-scope/sessions/groups";
import { count } from "./model.ts";
import { Bar, byModel, ExpandRow, Stats, Toggle, useOpen } from "./parts.tsx";

export function Causes({
  calls,
  title,
  showAll,
}: {
  calls: SessionCall[];
  title?: (call: SessionCall) => string;
  showAll: (label: string, calls: SessionCall[]) => void;
}) {
  const groups = useMemo(() => byCause(calls), [calls]);
  const [open, toggle] = useOpen();
  const failures = groups.reduce((sum, group) => sum + group.calls.length, 0);
  const other = groups.find((group) => group.cause === OTHER_CAUSE)?.calls.length ?? 0;
  const max = Math.max(0, ...groups.map((group) => group.calls.length));
  if (!failures) return <p className="sessions-empty">No failed tool calls in this view.</p>;
  return (
    <>
      <Stats
        items={[
          [count(failures), `Failed of ${count(calls.length)} tool calls`, "fail"],
          [`${((100 * failures) / calls.length).toFixed(1)}%`, "Failure rate"],
          [
            `${((100 * other) / failures).toFixed(0)}%`,
            `Cause not recognized (${count(other)} calls)`,
            "warn",
          ],
        ]}
      />
      <div className="sessions-card">
        <table className="sessions-table sessions-grouped">
          <thead>
            <tr>
              <th />
              <th>Cause</th>
              <th>Failed</th>
              <th>By model</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.cause}>
                <ExpandRow
                  label={group.cause}
                  open={open.has(group.cause)}
                  onToggle={() => toggle(group.cause)}
                  className={group.cause === OTHER_CAUSE ? "sessions-leftover" : ""}
                >
                  <Toggle open={open.has(group.cause)} />
                  <td className="sessions-nowrap">{group.cause}</td>
                  <td className="sessions-cause-bar">
                    <Bar
                      value={group.calls.length}
                      max={max}
                      label={String(group.calls.length)}
                      tone="fail"
                    />
                  </td>
                  <td className="sessions-muted">
                    {byModel(group.calls.map((entry) => entry.call))
                      .map(([model, entry]) => `${model} ${entry.calls}`)
                      .join(" · ")}
                  </td>
                </ExpandRow>
                {open.has(group.cause) && (
                  <tr className="sessions-detail">
                    <td />
                    <td colSpan={3}>
                      <CauseDetail
                        group={group}
                        title={title}
                        showAll={() =>
                          showAll(
                            `Cause: ${group.cause}`,
                            group.calls.map((entry) => entry.call),
                          )
                        }
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sessions-note">
        Each cause is read from the call's output; the first matching rule wins. The marked line is
        the one that decided it.
      </p>
    </>
  );
}

function CauseDetail({
  group,
  title,
  showAll,
}: {
  group: CauseGroup;
  title?: (call: SessionCall) => string;
  showAll: () => void;
}) {
  return (
    <>
      {group.calls.slice(0, 3).map(({ call, evidence }, index) => (
        <div key={index} className="sessions-example">
          {title && <div className="sessions-sub">{title(call)}</div>}
          <code>…{call.input.slice(-160)}</code>
          <div className="sessions-evidence">{evidence || "(no output)"}</div>
        </div>
      ))}
      <button type="button" className="sessions-link" onClick={showAll}>
        {group.calls.length === 1
          ? "Show this call →"
          : `Show all ${count(group.calls.length)} calls →`}
      </button>
    </>
  );
}
