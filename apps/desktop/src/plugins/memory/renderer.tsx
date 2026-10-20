import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { decode } from "@irudd-scope/protocol";
import type { LibrarianHumanCommand, LibrarianProposal } from "@irudd-scope/protocol/librarian";
import type { TabPlugin, TabProps } from "../api.ts";
import type { TabState } from "../../workspace/contract.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { SettingsContext } from "../../renderer/settings-context.tsx";
import { useLibrarian } from "../../renderer/librarian-state.ts";
import { MemoryTabState, memoryFields } from "./contract.ts";
import { applicability, memoryKind, memoryStage } from "./format.ts";
import { BrowseView } from "./browse.tsx";
import { ConnectionsView } from "./connections.tsx";
import { StagesView } from "./stages.tsx";
import { ActivityView } from "./activity.tsx";
import { MachinesView } from "./machines.tsx";
import { current, openChange, type Navigation } from "./navigation.ts";
import { Markdown } from "./wiki.tsx";
import "./style.css";

const SECTIONS = [
  { view: "browse", label: "Browse" },
  { view: "connections", label: "Connections" },
  { view: "stages", label: "Stages" },
  { view: "activity", label: "Activity" },
  { view: "machines", label: "Machines" },
] as const;
type Section = (typeof SECTIONS)[number]["view"];
const sectionOf = (view: string): Section | undefined =>
  view === "memory" ? "browse" : SECTIONS.find((section) => section.view === view)?.view;
const POSITIONS = ["browse", "memory", "connections", "stages", "activity", "machines"] as const;
type Positioned = (typeof POSITIONS)[number];

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
  const before = display?.beforeMemory ? memoryFields(display.beforeMemory) : null;
  const after = display?.afterMemory ? memoryFields(display.afterMemory) : null;
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
        <Markdown
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
            <Markdown text={display?.beforeBody ?? "No memory"} />
          </section>
          <section>
            <h3>After</h3>
            <Markdown text={display?.afterBody ?? "Memory removed"} />
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
function MemoryView({ tab, active, context }: TabProps) {
  const saved = decode(MemoryTabState, tab.state);
  const legacy = saved.version === 1 ? saved.data : (saved.data.recovery ?? {});
  const settings = useContext(SettingsContext);
  const { state, setState, error, setError } = useLibrarian();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState("");
  // A failed read is not saved, so Retry must resend it rather than the view still stored.
  const failed = useRef<Navigation>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const positions = useRef<Partial<Record<Positioned, number>> & { memoryPath?: string }>(
    saved.version === 3 ? { ...saved.data.positions } : {},
  );
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shown = useRef<{ view?: string; path?: string }>({});

  const initialized = useRef<string>(undefined);
  // Commands carry the displayed revision, so one sent before the previous reply would fail. A
  // navigation made meanwhile waits and runs next against the newer revision; other commands are
  // offered only while idle.
  const running = useRef(false);
  const waiting = useRef<Navigation>(undefined);
  const revision = useRef(state?.uiRevision);
  const focus = useRef(state?.focusPath);
  revision.current = state?.uiRevision ?? revision.current;
  focus.current = state?.focusPath;
  async function run(command: LibrarianHumanCommand, navigation?: Navigation) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    // The change notification can render the new state before this reply arrives.
    const remembered = focus.current;
    const library = state?.bundle?.id;
    try {
      const next = await window.scope.librarianHuman(JSON.parse(JSON.stringify(command)));
      // The main process forgets a selected memory that dreaming or sync removed.
      setNotice(
        command.action === "navigate" &&
          remembered &&
          !next.focusPath &&
          next.bundle?.id === library
          ? "That memory is no longer in the library."
          : "",
      );
      revision.current = next.uiRevision;
      focus.current = next.focusPath;
      // A change notification may already have delivered a newer state.
      setState((shown) => (shown && shown.uiRevision > next.uiRevision ? shown : next));
      failed.current = undefined;
    } catch (cause) {
      failed.current = navigation;
      setError(cause instanceof Error ? cause.message : "Could not load memory. Retry.");
    } finally {
      running.current = false;
      setBusy(false);
      const queued = waiting.current;
      waiting.current = undefined;
      if (queued) void navigate(queued);
    }
  }
  function navigate(selection: Navigation) {
    if (revision.current === undefined) return;
    if (running.current) {
      waiting.current = selection;
      return;
    }
    return run(
      {
        action: "navigate",
        requestId: crypto.randomUUID(),
        expectedUiRevision: revision.current,
        ...selection,
      },
      selection,
    );
  }
  useEffect(() => {
    if (!active || !state || initialized.current === (state.bundle?.id ?? "unset")) return;
    initialized.current = state.bundle?.id ?? "unset";
    const stale =
      (state.view === "browse" || state.view === "memory") && state.facets === undefined;
    if ((state.displayed === null && state.view === "browse") || stale)
      void navigate(current(state));
  }, [active, state]);
  useEffect(() => () => clearTimeout(saving.current), []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !state) return;
    const key = POSITIONS.find((view) => view === state.view);
    const previous = shown.current;
    shown.current = { view: state.view, path: state.selectedPath };
    if (previous.view === state.view && previous.path === state.selectedPath) return;
    // Returning to a view restores its place; a memory other than the one saved opens at its top.
    const other = key === "memory" && positions.current.memoryPath !== state.selectedPath;
    const restore =
      previous.view === state.view || other || !key ? 0 : (positions.current[key] ?? 0);
    element.scrollTop = restore;
    if (key) positions.current[key] = restore;
    if (key === "memory") positions.current.memoryPath = state.selectedPath;
  }, [state?.view, state?.selectedPath]);
  if (!state)
    return (
      <div className="memory-view">
        <p role="status">{error || "Loading memory…"}</p>
      </div>
    );
  function remember() {
    const element = scroller.current;
    const key = POSITIONS.find((view) => view === state?.view) as Positioned | undefined;
    if (!element || !key || saved.version === 1) return;
    positions.current[key] = Math.round(element.scrollTop);
    clearTimeout(saving.current);
    saving.current = setTimeout(
      () =>
        context.updateState({
          version: 3,
          data: { ...saved.data, positions: { ...positions.current } } as TabState["data"],
        }),
      500,
    );
  }
  const proposal = state.displayed as LibrarianProposal | null;
  const selected = state.run?.proposals.find((p) => p.change.id === state.selectedChangeId);
  const completed = state.overview ?? [];
  const section = sectionOf(state.view);
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
  function open(view: Section) {
    if (view === "browse")
      return navigate(
        state!.focusPath && state!.browse?.reading !== false
          ? { view: "memory", path: state!.focusPath, trail: [...(state!.browse?.trail ?? [])] }
          : current({ ...state!, view: "browse" }),
      );
    return navigate({ view });
  }
  return (
    <div
      ref={scroller}
      className="memory-view librarian-view"
      aria-label="Librarian"
      onScroll={remember}
    >
      {error && (
        <div role="alert" className="memory-error">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void navigate(failed.current ?? current(state))}
          >
            Retry
          </Button>
          <Button variant="ghost" onClick={() => settings?.openSettings("memory")}>
            Memory settings
          </Button>
        </div>
      )}
      {section && (
        <div className="librarian-header">
          <p className="librarian-note">
            Personal library on this desktop
            {busy && <span role="status"> · Reading…</span>}
            {notice && <span role="status"> · {notice}</span>}
          </p>
          {SECTIONS.length > 1 && (
            <div
              role="tablist"
              aria-label="Librarian views"
              className="librarian-tabs"
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = SECTIONS.findIndex((entry) => entry.view === section);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? SECTIONS.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + SECTIONS.length) %
                        SECTIONS.length;
                const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]");
                tabs[next]?.focus();
                void open(SECTIONS[next]!.view);
              }}
            >
              {SECTIONS.map((entry) => (
                <button
                  key={entry.view}
                  role="tab"
                  aria-selected={entry.view === section}
                  tabIndex={entry.view === section ? 0 : -1}
                  disabled={busy && entry.view !== section}
                  onClick={() => void open(entry.view)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <div className="memory-note-actions">
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
        </div>
      )}
      {(state.view === "browse" || state.view === "memory") && (
        <BrowseView
          state={state}
          busy={busy}
          navigate={(n) => void navigate(n)}
          onError={setError}
        />
      )}
      {state.view === "connections" && (
        <ConnectionsView state={state} navigate={(n) => void navigate(n)} />
      )}
      {state.view === "stages" && (
        <StagesView
          state={state}
          navigate={(n) => void navigate(n)}
          onChange={(id) => void navigate(openChange(state, id))}
        />
      )}
      {state.view === "activity" && (
        <ActivityView state={state} busy={busy} navigate={(n) => void navigate(n)} />
      )}
      {state.view === "machines" && (
        <MachinesView onSettings={() => settings?.openSettings("memory")} />
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
              <Button
                variant="ghost"
                onClick={() => void navigate(current({ ...state, view: "browse" }))}
              >
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
              void navigate(
                state.selectedChangeId
                  ? {
                      view: "overview",
                      ...(state.historyRunId ? { historyRunId: state.historyRunId } : {}),
                    }
                  : state.run?.status === "completed"
                    ? current({ ...state, view: "browse" })
                    : { view: "decision" },
              )
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
          <Button
            variant="ghost"
            onClick={() => void navigate(current({ ...state, view: "browse" }))}
          >
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
