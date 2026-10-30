import { Fragment, useMemo, useState } from "react";
import type { SessionTokens } from "@irudd-scope/sessions/contract";
import {
  count,
  duration,
  modelName,
  when,
  TOKEN_KINDS,
  totals,
  usd,
  type ThreadNode,
  type TreeTotals,
} from "./model.ts";

export function TokenBar({ tokens }: { tokens: SessionTokens }) {
  const sum = TOKEN_KINDS.reduce((total, [key]) => total + tokens[key], 0);
  return (
    <div
      className="sessions-tokbar"
      title={TOKEN_KINDS.map(([key, label]) => `${label}: ${count(tokens[key])}`).join("\n")}
    >
      {sum > 0 &&
        TOKEN_KINDS.map(([key, , tone]) => (
          <span
            key={key}
            className={`tok-${tone}`}
            style={{ width: `${(100 * tokens[key]) / sum}%` }}
          />
        ))}
    </div>
  );
}

export function TokenLegend() {
  return (
    <div className="sessions-legend">
      {TOKEN_KINDS.map(([key, label, tone]) => (
        <span key={key}>
          <i className={`tok-${tone}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

const sub = (node: ThreadNode, depth: number) => {
  const kind =
    depth === 0
      ? node.project
      : node.origin === "provider_native"
        ? "harness subagent"
        : "delegated thread";
  return node.children.length
    ? `${kind} · ${node.children.length} child thread${node.children.length > 1 ? "s" : ""}`
    : kind;
};

/**
 * Thread rows. The left column expands child threads; the rest of the row opens the thread.
 * `own` shows a thread's own numbers instead of its whole tree's, with `ownLabel` beside it.
 */
export function ThreadTable({
  rows,
  onOpen,
  own,
}: {
  rows: ThreadNode[];
  onOpen: (node: ThreadNode) => void;
  own?: ThreadNode;
}) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const row = (node: ThreadNode, depth: number): React.ReactNode => {
    const open = expanded.has(node.id);
    const isOwn = node === own;
    const sum: TreeTotals = isOwn ? ownTotals(node) : totals(node);
    return (
      <Fragment key={node.id}>
        <tr
          className={`sessions-row ${depth ? "sessions-child" : ""} ${isOwn ? "sessions-own" : ""}`}
        >
          {node.children.length && !isOwn ? (
            <td className="sessions-twist sessions-can">
              <button
                type="button"
                aria-expanded={open}
                aria-label={`${open ? "Collapse" : "Expand"} ${node.children.length} child threads of ${node.title}`}
                onClick={() => toggle(node.id)}
              >
                {open ? "▾" : "▸"}
              </button>
            </td>
          ) : (
            <td className="sessions-twist" />
          )}
          <td>
            <button
              type="button"
              className="sessions-open"
              style={{ paddingLeft: depth * 24 }}
              onClick={() => onOpen(node)}
              disabled={isOwn}
            >
              <span className="sessions-title">
                {node.title || "Untitled thread"}
                {isOwn && <span className="sessions-tag">This thread</span>}
              </span>
              <span className="sessions-sub">{isOwn ? "its own numbers" : sub(node, depth)}</span>
            </button>
          </td>
          <td>
            {sum.models.map((model) => (
              <span key={model} className="sessions-chip">
                {modelName(model)}
              </span>
            ))}
          </td>
          <td className="sessions-muted sessions-nowrap">{when(sum.start)}</td>
          <td className="num">
            {sum.start !== null && sum.end !== null ? duration(sum.end - sum.start) : "–"}
          </td>
          <td className="num">{duration(sum.agentMs || null)}</td>
          <td>
            <TokenBar tokens={sum.tokens} />
          </td>
          <td className="num">{usd(sum.cost)}</td>
          <td className="num">{count(sum.calls)}</td>
          <td className={`num ${sum.failed ? "sessions-failed" : "sessions-muted"}`}>
            {sum.failed}
          </td>
        </tr>
        {open && !isOwn && node.children.map((child) => row(child, depth + 1))}
      </Fragment>
    );
  };
  return (
    <div className="sessions-card">
      <table className="sessions-table sessions-threads">
        <thead>
          <tr>
            <th />
            <th>Thread</th>
            <th>Models</th>
            <th>Started</th>
            <th className="num" title="From the first request to the last reply">
              Took
            </th>
            <th className="num" title="Time agents spent working, added up over threads">
              Agent time
            </th>
            <th>Tokens</th>
            <th className="num" title="List price">
              Cost
            </th>
            <th className="num">Tool calls</th>
            <th className="num">Failed</th>
          </tr>
        </thead>
        <tbody>{rows.map((node) => row(node, own && node !== own ? 1 : 0))}</tbody>
      </table>
    </div>
  );
}

function ownTotals(node: ThreadNode): TreeTotals {
  return {
    cost: node.cost,
    tokens: node.tokens,
    calls: node.calls.length,
    failed: node.calls.filter((call) => call.status !== "completed").length,
    models: node.models,
    start: node.start,
    end: node.end,
    agentMs: node.agentMs,
    threads: 1,
  };
}

type Where = "titles" | "instructions" | "outcome";
const WHERE: Array<[Where, string]> = [
  ["titles", "Titles"],
  ["instructions", "What they were told"],
  ["outcome", "What they reported"],
];

/** Top-level threads, searchable by title or by what each thread was told or reported. */
export function ThreadsList({
  roots,
  all,
  onOpen,
}: {
  roots: ThreadNode[];
  all: ThreadNode[];
  onOpen: (node: ThreadNode) => void;
}) {
  const [search, setSearch] = useState("");
  const [where, setWhere] = useState<Where>("titles");
  const needle = search.trim().toLowerCase();
  const hits = useMemo(
    () =>
      where === "titles" || !needle
        ? []
        : all.filter((node) => node[where].toLowerCase().includes(needle)),
    [all, where, needle],
  );
  const titled = roots.filter((node) => !needle || node.title.toLowerCase().includes(needle));
  return (
    <>
      <div className="sessions-filters">
        <input
          type="search"
          className="sessions-search"
          placeholder="Search threads"
          aria-label="Search threads"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="sessions-label">in</span>
        <div className="sessions-seg" role="group" aria-label="Search in">
          {WHERE.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={where === value}
              onClick={() => setWhere(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {where !== "titles" && needle ? (
        <SearchHits hits={hits} total={all.length} where={where} needle={needle} onOpen={onOpen} />
      ) : titled.length ? (
        <>
          <ThreadTable rows={titled} onOpen={onOpen} />
          <TokenLegend />
        </>
      ) : (
        <p className="sessions-empty">No threads match.</p>
      )}
    </>
  );
}

function SearchHits({
  hits,
  total,
  where,
  needle,
  onOpen,
}: {
  hits: ThreadNode[];
  total: number;
  where: "instructions" | "outcome";
  needle: string;
  onOpen: (node: ThreadNode) => void;
}) {
  return (
    <>
      <p className="sessions-note sessions-note-top">
        <b>{hits.length}</b> of {total} threads{" "}
        {where === "instructions" ? "were told" : "reported"} “{needle}”.
      </p>
      {hits.length > 0 && (
        <div className="sessions-card">
          {hits.slice(0, 100).map((node) => {
            const text = node[where];
            const at = text.toLowerCase().indexOf(needle);
            const from = Math.max(0, at - 160);
            return (
              <button
                key={node.id}
                type="button"
                className="sessions-hit"
                onClick={() => onOpen(node)}
              >
                <span className="sessions-title">{node.title || "Untitled thread"}</span>
                <span className="sessions-sub">
                  {node.project} · {node.models.map(modelName).join(", ") || "Unknown model"}
                </span>
                <span className="sessions-hit-text">
                  {from > 0 && "…"}
                  {text.slice(from, at)}
                  <mark>{text.slice(at, at + needle.length)}</mark>
                  {text.slice(at + needle.length, at + needle.length + 240)}…
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
