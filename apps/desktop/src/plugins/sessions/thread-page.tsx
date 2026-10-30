import { useEffect, useRef, useState } from "react";
import type { SessionCall } from "@irudd-scope/sessions/contract";
import { ToolCalls } from "./calls.tsx";
import {
  ancestors,
  count,
  descendants,
  duration,
  modelName,
  totals,
  usd,
  type ThreadNode,
} from "./model.ts";
import { ThreadTable, TokenBar, TokenLegend } from "./threads.tsx";

/** One thread with everything below it: totals over the tree, its threads, messages and calls. */
export function ThreadPage({
  node,
  byId,
  onOpen,
  onBack,
}: {
  node: ThreadNode;
  byId: Map<string, ThreadNode>;
  onOpen: (node: ThreadNode | null) => void;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [node]);
  const sum = totals(node);
  const tree = descendants(node);
  const titles = new Map(tree.map((thread) => [thread.id, thread.title || "Untitled thread"]));
  const calls: SessionCall[] = tree.flatMap((thread) => thread.calls);
  // A thread with a hundred child threads would push the rest far down, so one section shows at a time.
  const sections = (
    [
      ["calls", "Tool calls", calls.length],
      ["threads", "Threads", node.children.length ? node.children.length + 1 : 0],
      ["messages", "Messages", node.messages.length],
    ] as const
  ).filter(([value, , size]) => value === "calls" || size > 0);
  const [chosen, setChosen] = useState<(typeof sections)[number][0]>("calls");
  const section = sections.some(([value]) => value === chosen) ? chosen : "calls";
  return (
    <div className="sessions-page">
      <nav className="sessions-crumbs" aria-label="Thread path">
        <button type="button" onClick={onBack}>
          Threads
        </button>
        {ancestors(node, byId).map((parent) => (
          <span key={parent.id}>
            <span aria-hidden="true">›</span>
            <button type="button" onClick={() => onOpen(parent)}>
              {parent.title || "Untitled thread"}
            </button>
          </span>
        ))}
        <span aria-hidden="true">›</span>
        <span className="sessions-here" aria-current="page">
          {node.title || "Untitled thread"}
        </span>
      </nav>
      <div className="sessions-top">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {node.title || "Untitled thread"}
          </h2>
          <div className="sessions-sub">
            {node.project}
            {sum.threads > 1 ? ` · totals include ${sum.threads - 1} child threads` : ""}
          </div>
        </div>
        <div className="sessions-top-right">
          <div className="sessions-stats">
            {(
              [
                [usd(sum.cost), "Cost (list price)"],
                [
                  sum.start !== null && sum.end !== null ? duration(sum.end - sum.start) : "–",
                  "Took",
                ],
                [duration(sum.agentMs || null), "Agent time"],
                [count(sum.calls), "Tool calls"],
                [count(sum.failed), "Failed", sum.failed ? "fail" : ""],
              ] as const
            ).map(([value, label, tone]) => (
              <div key={label} className="sessions-stat">
                <div className={`sessions-stat-value ${tone ?? ""}`}>{value}</div>
                <div className="sessions-stat-label">{label}</div>
              </div>
            ))}
          </div>
          <TokenBar tokens={sum.tokens} />
          <TokenLegend />
        </div>
      </div>

      <div className="sessions-seg sessions-sections" role="group" aria-label="Show">
        {sections.map(([value, label, size]) => (
          <button
            key={value}
            type="button"
            aria-pressed={section === value}
            onClick={() => setChosen(value)}
          >
            {label} ({count(size)})
          </button>
        ))}
      </div>

      {section === "threads" && (
        <section>
          <h3>Threads</h3>
          <ThreadTable rows={[node, ...node.children]} onOpen={onOpen} own={node} />
        </section>
      )}

      {section === "messages" && (
        <section>
          <h3>Messages in this thread</h3>
          <div className="sessions-card">
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Message</th>
                  <th>Model</th>
                  <th>Result</th>
                  <th className="num">Took</th>
                  <th className="num">Output tokens</th>
                  <th className="num">Context used</th>
                  <th className="num">Cost</th>
                  <th className="num">Tool calls</th>
                </tr>
              </thead>
              <tbody>
                {node.messages.map((message) => (
                  <tr key={message.ordinal}>
                    <td>{message.ordinal}</td>
                    <td>
                      {modelName(message.model)}
                      <span className="sessions-muted">
                        {message.effort ? ` · ${message.effort}` : ""}
                        {message.fast ? " · fast" : ""}
                      </span>
                    </td>
                    <td
                      className={
                        message.status === "completed" ? "sessions-muted" : "sessions-failed"
                      }
                    >
                      {message.status}
                    </td>
                    <td className="num">{duration(message.durationMs)}</td>
                    <td className="num">{message.tokens ? count(message.tokens.output) : "–"}</td>
                    <td className="num">
                      {message.contextUsed !== null && message.contextMax
                        ? `${count(message.contextUsed / 1000)}k of ${count(message.contextMax / 1000)}k`
                        : "–"}
                    </td>
                    <td className="num">{message.cost === null ? "–" : usd(message.cost)}</td>
                    <td className="num">
                      {count(node.calls.filter((call) => call.message === message.ordinal).length)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {section === "calls" && (
        <section>
          <h3>Tool calls{sum.threads > 1 ? " in this thread and its child threads" : ""}</h3>
          {calls.length ? (
            <ToolCalls
              calls={calls}
              title={sum.threads > 1 ? (call) => titles.get(call.threadId) ?? "" : undefined}
            />
          ) : (
            <p className="sessions-empty">This thread made no tool calls.</p>
          )}
        </section>
      )}
    </div>
  );
}
