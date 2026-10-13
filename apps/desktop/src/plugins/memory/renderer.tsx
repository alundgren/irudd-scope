import { useContext, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Search } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import type { LibrarianHumanCommand, LibrarianProposal } from "@irudd-scope/protocol/librarian";
import type { TabPlugin, TabProps } from "../api.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import { useLibrarian } from "../../renderer/librarian-state.ts";
import { MemoryTabState, type MemoryConcept, type MemorySearch } from "./contract.ts";
import { MemoryWiki } from "./wiki.tsx";
import "./style.css";

type Navigation = Omit<
  Extract<LibrarianHumanCommand, { action: "navigate" }>,
  "requestId" | "expectedUiRevision" | "action"
>;
type Browse = {
  entries: { path: string; kind: "directory" | "memory"; title?: string }[];
  total?: number;
  truncated: boolean;
};
type MemoryFields = {
  kind?: string;
  stage?: string;
  applicability?: { type: string; id?: string };
};
const memoryKind = (kind: string | undefined) =>
  ({ procedural: "Procedure", episodic: "Experience", semantic: "Fact" })[kind ?? ""] ?? "Memory";
const memoryStage = (stage: string | undefined) =>
  stage ? stage[0]!.toUpperCase() + stage.slice(1) : "";
function applicability(value: MemoryFields["applicability"]) {
  if (!value) return "No scope";
  if (value.type === "global") return "Everywhere";
  return `${value.type === "repository" ? "Repository" : "Machine"} ${value.id}`;
}
function Body({ text }: { text: string }) {
  return (
    <article className="memory-wiki markdown-document">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
function Proposal({
  proposal,
  comparison,
  evidence,
  onInspect,
}: {
  proposal: LibrarianProposal;
  comparison: boolean;
  evidence: boolean;
  onInspect: (value: { comparison?: boolean; evidence?: boolean }) => void;
}) {
  const change = proposal.change;
  const display = change.display;
  const before = display?.beforeMemory as MemoryFields | null;
  const after = display?.afterMemory as MemoryFields | null;
  const changes =
    before && after
      ? [
          ...(before.kind !== after.kind
            ? [`Memory type: ${memoryKind(before.kind)} → ${memoryKind(after.kind)}`]
            : []),
          ...(before.stage !== after.stage
            ? [`Stage: ${memoryStage(before.stage)} → ${memoryStage(after.stage)}`]
            : []),
          ...(JSON.stringify(before.applicability) !== JSON.stringify(after.applicability)
            ? [
                `Applies: ${applicability(before.applicability)} → ${applicability(after.applicability)}`,
              ]
            : []),
        ]
      : after?.applicability
        ? [
            `${memoryKind(after.kind)} · ${memoryStage(after.stage)} · Applies: ${applicability(after.applicability)}`,
          ]
        : [];
  return (
    <section className="librarian-proposal" aria-label="Displayed proposal">
      <h2>{display?.title || "Memory proposal"}</h2>
      <p>{change.reason}</p>
      {changes.map((text) => (
        <p key={text}>{text}</p>
      ))}
      {change.sources
        .filter(
          (source) =>
            source.applicability &&
            source.applicability.type !== "global" &&
            JSON.stringify(source.applicability) !== JSON.stringify(after?.applicability),
        )
        .map((source, index) => (
          <p key={index}>Evidence applies to {applicability(source.applicability)}.</p>
        ))}
      {change.action === "delete" ? (
        <p>This memory will be removed.</p>
      ) : (
        <Body
          text={
            display?.afterBody ??
            "The memory text is unavailable. Ask your agent to refresh this proposal."
          }
        />
      )}
      <div className="memory-note-actions">
        {change.before && (
          <Button
            variant="ghost"
            aria-expanded={comparison}
            onClick={() => onInspect({ comparison: !comparison })}
          >
            {comparison ? "Hide comparison" : "Compare changes"}
          </Button>
        )}
        <Button
          variant="ghost"
          aria-expanded={evidence}
          onClick={() => onInspect({ evidence: !evidence })}
        >
          {evidence ? "Hide evidence" : "Inspect evidence"}
        </Button>
      </div>
      {comparison && (
        <div className="librarian-comparison">
          <section>
            <h3>Before</h3>
            <Body text={display?.beforeBody ?? "No memory"} />
          </section>
          <section>
            <h3>After</h3>
            <Body text={display?.afterBody ?? "Memory removed"} />
          </section>
        </div>
      )}
      {evidence && (
        <section aria-label="Proposal evidence">
          <p>{proposal.evidence}</p>
          {change.sources.map((source, index) => (
            <p key={index}>{source.displayTitle || "Source memory"}</p>
          ))}
          {(change.reviews ?? (change.review ? [change.review] : [])).map((review, index) => (
            <p key={index}>
              {review.decision === "accept" ? "Accepted" : "Rejected"} by{" "}
              {review.actor.type === "human" ? "you" : "your agent"}. {review.reason}
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
function MemoryView({ tab, active }: TabProps) {
  const saved = decode(MemoryTabState, tab.state);
  const legacy = saved.version === 1 ? saved.data : (saved.data.recovery ?? {});
  const settings = useContext(SettingsContext);
  const { state, setState, error, setError } = useLibrarian();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);

  const initialized = useRef<string>(undefined);
  async function run(command: LibrarianHumanCommand) {
    setBusy(true);
    setError("");
    try {
      setState(await window.scope.librarianHuman(JSON.parse(JSON.stringify(command))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load memory. Retry.");
    } finally {
      setBusy(false);
    }
  }
  function navigate(selection: Navigation) {
    if (!state || busy) return;
    return run({
      action: "navigate",
      requestId: crypto.randomUUID(),
      expectedUiRevision: state.uiRevision,
      ...selection,
    });
  }
  useEffect(() => {
    if (!active || !state || initialized.current === (state.bundle?.id ?? "unset")) return;
    initialized.current = state.bundle?.id ?? "unset";
    if (state.displayed === null && state.view === "browse") void navigate({ view: "browse" });
  }, [active, state]);
  useEffect(() => {
    if (state?.view === "browse") setQuery(state.query);
  }, [state?.query, state?.view]);
  if (!state)
    return (
      <div className="memory-view">
        <p role="status">{error || "Loading memory…"}</p>
      </div>
    );
  const proposal = state.displayed as LibrarianProposal | null;
  const selected = state.run?.proposals.find((p) => p.change.id === state.selectedChangeId);
  const completed = state.overview ?? [];
  async function decide(decision: "accept" | "reject") {
    if (!state?.run || !selected) return;
    await run({
      action: "decide",
      requestId: crypto.randomUUID(),
      expectedUiRevision: state.uiRevision,
      runId: state.run.id,
      changeId: selected.change.id,
      expectedRevisionHash: selected.change.revisionHash,
      sources: selected.change.sources,
      decision,
      reason:
        decision === "accept"
          ? "Accepted the displayed proposal."
          : "Rejected the displayed proposal.",
    });
  }
  const browse = state.displayed as Browse | MemorySearch | null;
  return (
    <div className="memory-view librarian-view" aria-label="Librarian">
      {error && (
        <div role="alert" className="memory-error">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void navigate({
                view: state.view,
                path: state.selectedPath,
                changeId: state.selectedChangeId,
                query: state.query,
                directory: state.directory,
                offset: state.offset,
              })
            }
          >
            Retry
          </Button>
          <Button variant="ghost" onClick={() => settings?.openSettings("memory")}>
            Memory settings
          </Button>
        </div>
      )}
      {state.view === "browse" && (
        <>
          <form
            className="memory-search"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate({ view: "browse", query });
            }}
          >
            <Input
              aria-label="Search memory"
              placeholder="Search memory…"
              value={query}
              maxLength={512}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button
              variant="ghost"
              size="icon"
              type="submit"
              aria-label="Search memory"
              disabled={busy}
            >
              <Search />
            </Button>
          </form>
          <div className="memory-note-actions">
            {(state.query || state.directory) && (
              <Button
                variant="ghost"
                onClick={() =>
                  void navigate({
                    view: "browse",
                    directory: state.directory.split("/").slice(0, -1).join("/"),
                  })
                }
              >
                Back
              </Button>
            )}
            {state.run && (
              <Button
                variant="ghost"
                onClick={() =>
                  void navigate({
                    view: state.run?.status === "completed" ? "overview" : "decision",
                  })
                }
              >
                {state.run.status === "completed" ? "Completed dreaming" : "Dreaming"}
              </Button>
            )}
            {legacy.draft && (
              <Button variant="ghost" onClick={() => void navigate({ view: "recovery" })}>
                Recovered draft
              </Button>
            )}
          </div>
          <ul className="memory-link-list" aria-label="Memory results">
            {browse && "entries" in browse
              ? browse.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void navigate(
                          entry.kind === "directory"
                            ? { view: "browse", directory: entry.path }
                            : { view: "memory", path: entry.path },
                        )
                      }
                    >
                      {entry.title || entry.path.split("/").at(-1)}
                    </button>
                  </li>
                ))
              : browse && "results" in browse
                ? browse.results.map((hit) => (
                    <li key={hit.path}>
                      <button
                        disabled={busy}
                        onClick={() => void navigate({ view: "memory", path: hit.path })}
                      >
                        {hit.title}
                      </button>
                      <p>{hit.excerpt || hit.description}</p>
                    </li>
                  ))
                : null}
          </ul>
          {browse &&
            (("entries" in browse && !browse.entries.length) ||
              ("results" in browse && !browse.results.length)) && <p>No memories found.</p>}
          {browse && (
            <div className="memory-note-actions">
              {state.offset > 0 && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void navigate({
                      view: "browse",
                      query: state.query,
                      directory: state.directory,
                      offset: Math.max(0, state.offset - (state.query ? 30 : 20)),
                    })
                  }
                >
                  Previous
                </Button>
              )}
              {browse.truncated && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void navigate({
                      view: "browse",
                      query: state.query,
                      directory: state.directory,
                      offset: state.offset + (state.query ? 30 : 20),
                    })
                  }
                >
                  Next
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {state.view === "memory" && state.displayed !== null && (
        <>
          <Button
            variant="ghost"
            onClick={() =>
              void navigate({
                view: "browse",
                query: state.query,
                directory: state.directory,
                offset: state.offset,
              })
            }
          >
            Back to results
          </Button>
          <MemoryWiki
            concept={state.displayed as MemoryConcept}
            onOpen={(path) => void navigate({ view: "memory", path })}
            onError={setError}
          />
        </>
      )}
      {state.view === "decision" && (
        <>
          {state.run?.status === "interrupted" && (
            <p>Dreaming is paused. Ask your existing agent to resume when you are ready.</p>
          )}
          {selected && proposal ? (
            <>
              <Proposal
                proposal={proposal}
                comparison={state.comparisonOpen ?? false}
                evidence={state.evidenceOpen ?? false}
                onInspect={(value) =>
                  void run({
                    action: "inspect",
                    requestId: crypto.randomUUID(),
                    expectedUiRevision: state.uiRevision,
                    ...value,
                  })
                }
              />
              <div className="memory-note-actions">
                <Button disabled={busy} onClick={() => void decide("accept")}>
                  Accept proposal
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void decide("reject")}>
                  Reject proposal
                </Button>
              </div>
            </>
          ) : (
            <p>
              {state.pendingCount
                ? "Choose the next decision with your agent."
                : "No decisions waiting. Continue with your existing agent."}
            </p>
          )}
          {!selected && (
            <div className="memory-note-actions">
              <Button variant="ghost" onClick={() => void navigate({ view: "browse" })}>
                Browse memories
              </Button>
              {!!state.completedCount && (
                <Button variant="ghost" onClick={() => void navigate({ view: "overview" })}>
                  Inspect completed changes
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {state.view === "overview" && (
        <>
          <Button
            variant="ghost"
            onClick={() =>
              void navigate({
                view: state.selectedChangeId
                  ? "overview"
                  : state.run?.status === "completed"
                    ? "browse"
                    : "decision",
              })
            }
          >
            Back
          </Button>
          {state.selectedChangeId && proposal ? (
            <Proposal
              proposal={proposal}
              comparison={state.comparisonOpen ?? false}
              evidence={state.evidenceOpen ?? false}
              onInspect={(value) =>
                void run({
                  action: "inspect",
                  requestId: crypto.randomUUID(),
                  expectedUiRevision: state.uiRevision,
                  ...value,
                })
              }
            />
          ) : (
            <>
              <p>
                {state.completedCount} completed {state.completedCount === 1 ? "change" : "changes"}
                .
              </p>
              <ul className="memory-link-list">
                {completed.map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() =>
                        void navigate({
                          view: "overview",
                          historyRunId: state.historyRunId,
                          changeId: item.id,
                        })
                      }
                    >
                      {item.title || "Memory"}
                    </button>
                    <small>
                      {item.status} · {item.actor}
                    </small>
                  </li>
                ))}
              </ul>
              <div className="memory-note-actions">
                {state.offset > 0 && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void navigate({
                        view: "overview",
                        historyRunId: state.historyRunId,
                        offset: Math.max(0, state.offset - 10),
                      })
                    }
                  >
                    Previous
                  </Button>
                )}
                {state.offset + 10 < (state.completedCount ?? 0) && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void navigate({
                        view: "overview",
                        historyRunId: state.historyRunId,
                        offset: state.offset + 10,
                      })
                    }
                  >
                    Next
                  </Button>
                )}
              </div>
              {!!state.history.length && (
                <Button variant="ghost" onClick={() => setHistory(!history)}>
                  Earlier dreaming
                </Button>
              )}
              {history && (
                <ul className="memory-link-list">
                  {state.history
                    .slice(-10)
                    .reverse()
                    .map((run) => (
                      <li key={run.id}>
                        <button
                          onClick={() => void navigate({ view: "overview", historyRunId: run.id })}
                        >
                          {new Date(run.startedAt).toLocaleDateString()}
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      {state.view === "recovery" && (
        <>
          <Button variant="ghost" onClick={() => void navigate({ view: "browse" })}>
            Back
          </Button>
          {legacy.draft ? (
            <>
              <p>{legacy.draft.path}</p>
              <pre className="librarian-recovered">{legacy.draft.raw}</pre>
              <Button
                variant="secondary"
                onClick={() =>
                  void window.scope
                    .copyMemoryDraft(legacy.draft!.raw)
                    .catch(() => setError("Could not copy the recovered draft. Retry."))
                }
              >
                Copy recovered draft
              </Button>
            </>
          ) : (
            <p>No recovered draft.</p>
          )}
        </>
      )}
    </div>
  );
}
export const memoryPlugin: TabPlugin = { type: "memory", View: MemoryView };
