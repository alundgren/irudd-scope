import { Fragment, useId, useMemo, useState } from "react";
import type { SessionCall } from "@irudd-scope/sessions/contract";
import { failed } from "@irudd-scope/sessions/groups";
import { Causes } from "./causes.tsx";
import { count, duration, modelName } from "./model.ts";
import { ExpandRow, useOpen } from "./parts.tsx";
import { Programs } from "./programs.tsx";

type Grouping = "none" | "program" | "cause";
const GROUPINGS: Array<[Grouping, string]> = [
  ["none", "Nothing"],
  ["program", "Program"],
  ["cause", "Failure cause"],
];
const SHOWN = 300;

type Filter = { label: string; calls: Set<SessionCall> };

/**
 * Tool calls, flat or grouped by program or failure cause. `title` names a call's thread
 * when the calls come from more than one.
 */
export function ToolCalls({
  calls,
  title,
}: {
  calls: SessionCall[];
  title?: (call: SessionCall) => string;
}) {
  const [grouping, setGrouping] = useState<Grouping>("none");
  const [filter, setFilter] = useState<Filter | null>(null);
  const labelId = useId();
  const showAll = (label: string, shown: SessionCall[]) => {
    setFilter({ label, calls: new Set(shown) });
    setGrouping("none");
  };
  return (
    <div className="sessions-calls">
      <div className="sessions-filters">
        <span className="sessions-label" id={labelId}>
          Group by
        </span>
        <div className="sessions-seg" role="group" aria-labelledby={labelId}>
          {GROUPINGS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={grouping === value}
              onClick={() => {
                setGrouping(value);
                setFilter(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {filter && (
          <span className="sessions-chip-filter">
            {filter.label}
            <button type="button" aria-label="Clear filter" onClick={() => setFilter(null)}>
              ×
            </button>
          </span>
        )}
      </div>
      {grouping === "program" ? (
        <Programs calls={calls} showAll={showAll} />
      ) : grouping === "cause" ? (
        <Causes calls={calls} title={title} showAll={showAll} />
      ) : (
        <Flat
          calls={filter ? calls.filter((call) => filter.calls.has(call)) : calls}
          title={title}
        />
      )}
    </div>
  );
}

function Flat({ calls, title }: { calls: SessionCall[]; title?: (call: SessionCall) => string }) {
  const [search, setSearch] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [open, toggle] = useOpen();
  const shown = useMemo(() => {
    const needle = search.toLowerCase();
    return calls
      .filter((call) => !onlyFailed || failed(call))
      .filter(
        (call) =>
          !needle ||
          call.input.toLowerCase().includes(needle) ||
          call.name.toLowerCase().includes(needle) ||
          call.outputHead.toLowerCase().includes(needle) ||
          call.outputTail.toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  }, [calls, search, onlyFailed]);
  const maxMs = Math.max(1, ...shown.slice(0, SHOWN).map((call) => call.durationMs ?? 0));
  const maxChars = Math.max(1, ...shown.slice(0, SHOWN).map((call) => call.outputChars));
  return (
    <>
      <div className="sessions-filters">
        <input
          type="search"
          className="sessions-search"
          placeholder="Search commands and output"
          aria-label="Search commands and output"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label className="sessions-check">
          <input
            type="checkbox"
            checked={onlyFailed}
            onChange={(event) => setOnlyFailed(event.target.checked)}
          />
          Failed only
        </label>
        <span className="sessions-muted">
          {shown.length > SHOWN
            ? `Slowest ${SHOWN} of ${count(shown.length)}`
            : `${count(shown.length)} calls`}
        </span>
      </div>
      {shown.length ? (
        <div className="sessions-card">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Input</th>
                <th>Result</th>
                <th className="num">Took ↓</th>
                <th className="num">Output</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, SHOWN).map((call, index) => {
                const key = String(index);
                const isOpen = open.has(key);
                return (
                  <Fragment key={key}>
                    <ExpandRow
                      label={`${call.name}: ${call.input.slice(0, 80)}`}
                      open={isOpen}
                      onToggle={() => toggle(key)}
                    >
                      <td>
                        <div className="sessions-mono">{call.name}</div>
                        {title && <div className="sessions-sub">{title(call)}</div>}
                      </td>
                      <td className="sessions-mono sessions-cut">{call.input}</td>
                      <td className={failed(call) ? "sessions-failed" : "sessions-muted"}>
                        {call.status}
                        {call.exit ? ` · exit ${call.exit}` : ""}
                      </td>
                      <td className="num sessions-bar-cell">
                        <div>{duration(call.durationMs)}</div>
                        <div
                          className={`sessions-bar ${failed(call) ? "fail" : ""}`}
                          style={{ width: `${(100 * (call.durationMs ?? 0)) / maxMs}%` }}
                        />
                      </td>
                      <td className="num sessions-bar-cell">
                        <div>{count(call.outputChars)} chars</div>
                        <div
                          className="sessions-bar size"
                          style={{ width: `${(100 * call.outputChars) / maxChars}%` }}
                        />
                      </td>
                    </ExpandRow>
                    {isOpen && (
                      <tr className="sessions-detail">
                        <td colSpan={5}>
                          <div className="sessions-h">Input · {modelName(call.model)}</div>
                          <pre className="sessions-pre">{call.input}</pre>
                          <div className="sessions-h">
                            Output · {count(call.outputChars)} characters
                            {call.outputTail ? " · first and last 2 KB" : ""}
                          </div>
                          <pre className="sessions-pre">
                            {call.outputHead || "(no output)"}
                            {call.outputTail ? `\n\n[…]\n\n${call.outputTail}` : ""}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="sessions-empty">No tool calls match.</p>
      )}
    </>
  );
}
