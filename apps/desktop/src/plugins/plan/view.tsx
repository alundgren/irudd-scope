import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check as DoneIcon } from "lucide-react";
import { decode } from "@irudd-scope/protocol";
import {
  checkEvidence,
  itemInstruction,
  nextItemInstruction,
  planCommands,
  proposalOf,
  readPlan,
  type EvidenceState,
} from "@irudd-scope/protocol/plan";
import type { ArtifactContent } from "../../bridge.ts";
import type { TabProps } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { Button } from "../../renderer/components/ui/button.tsx";
import { PlanTabState } from "./contract.ts";
import { planHtml } from "./document.ts";
import { useDocumentScroll } from "./document-scroll.ts";
import { Check } from "./check.tsx";

const evidenceLabel: Record<EvidenceState, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  stale: "Stale",
  none: "No evidence",
};

function PlanContent({ content, ...props }: TabProps & { content: ArtifactContent }) {
  const plan = useMemo(() => readPlan(content.bytes), [content.bytes]);
  const state = decode(PlanTabState, props.tab.state).data;
  const stateRef = useRef(state);
  stateRef.current = state;
  const iframe = useRef<HTMLIFrameElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const view = state.view ?? "overview";
  // Progress is not part of the overview, so recording it never reloads the document.
  const html = useMemo(() => planHtml(proposalOf(plan)), [plan]);
  const done = useMemo(() => new Set(plan.doneItemIds), [plan]);
  const update = (patch: Partial<typeof state>) => {
    const data = Object.fromEntries(
      Object.entries({ ...stateRef.current, ...patch }).filter(([, value]) => value !== undefined),
    );
    stateRef.current = decode(PlanTabState, { version: 1, data }).data;
    props.context.updateState({ version: 1, data });
  };
  const observe = useDocumentScroll(
    iframe,
    props.active && view === "overview",
    html,
    state.scrollY ?? 0,
    (y) => update({ scrollY: y }),
  );
  useLayoutEffect(() => {
    if (props.active && view === "work" && work.current)
      work.current.scrollTop = stateRef.current.workScrollY ?? 0;
  }, [props.active, view, content.artifact.revision]);
  async function copy(text: string, copied: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(copied);
    } catch {
      setMessage("Could not copy. Select the command text instead.");
    }
  }
  const title = (id: string) => plan.items?.find((x) => x.id === id)?.title ?? id;
  // Scroll position changes must not rebuild the work item and evidence trees.
  const workItems = useMemo(
    () => (
      <>
        {plan.items?.length ? (
          <>
            <div className="plan-work-actions">
              <Button
                variant="outline"
                onClick={() =>
                  void copy(nextItemInstruction(content.artifact), "Next-item instruction copied.")
                }
              >
                Copy next-item instruction
              </Button>
              <p role="status">{message}</p>
            </div>
            <table className="plan-items">
              <thead>
                <tr>
                  <th scope="col">Done</th>
                  <th scope="col">Work item</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Depends on</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => {
                  const expanded = state.itemId === item.id;
                  const waiting = !done.has(item.id) && item.dependsOn.some((id) => !done.has(id));
                  const constraints = [...(plan.constraints ?? []), ...(item.constraints ?? [])];
                  return (
                    <Fragment key={item.id}>
                      <tr data-waiting={waiting || undefined} data-expanded={expanded || undefined}>
                        <td className="plan-done">
                          {done.has(item.id) && <DoneIcon aria-label="Done" size={18} />}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="plan-item-toggle"
                            aria-expanded={expanded}
                            onClick={() => update({ itemId: expanded ? undefined : item.id })}
                          >
                            {item.title}
                          </button>
                        </td>
                        <td>{item.outcome}</td>
                        <td>{item.dependsOn.map(title).join(", ")}</td>
                      </tr>
                      {expanded && (
                        <tr className="plan-item-detail">
                          <td colSpan={4}>
                            <Button
                              variant="outline"
                              onClick={() =>
                                void copy(
                                  itemInstruction(content.artifact, item),
                                  "Work item instruction copied.",
                                )
                              }
                            >
                              Copy work item
                            </Button>
                            <code className="plan-command">
                              {planCommands(content.artifact, item.id).item}
                            </code>
                            {item.context && <p>{item.context}</p>}
                            {!!constraints.length && (
                              <>
                                <h3>Constraints</h3>
                                <ul>
                                  {constraints.map((text, i) => (
                                    <li key={i}>{text}</li>
                                  ))}
                                </ul>
                              </>
                            )}
                            <h3>Checks</h3>
                            {item.checkIds.length ? (
                              (plan.checks ?? [])
                                .filter((x) => item.checkIds.includes(x.id))
                                .map((check) => {
                                  const { state: result, evidence } = checkEvidence(plan, check);
                                  return (
                                    <Check
                                      key={check.id}
                                      check={check}
                                      label={evidenceLabel[result]}
                                      result={result}
                                    >
                                      {evidence && (
                                        <>
                                          <h4>Observed</h4>
                                          <p>{evidence.observed}</p>
                                          <h4>Implementation</h4>
                                          <p>{evidence.implementation}</p>
                                          <h4>Tested under</h4>
                                          <p>{evidence.conditions}</p>
                                          {evidence.references?.map((reference, i) => (
                                            <p key={i}>{reference}</p>
                                          ))}
                                        </>
                                      )}
                                    </Check>
                                  );
                                })
                            ) : (
                              <p>No completion checks defined yet.</p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <p>
            No work items defined yet. Read the overview and discuss unresolved choices in chat.
          </p>
        )}
        {(plan.context || !!plan.questions?.length) && (
          <details>
            <summary>Plan context</summary>
            {plan.context && <p>{plan.context}</p>}
            {!!plan.questions?.length && (
              <>
                <h3>Unresolved questions</h3>
                <ul>
                  {plan.questions.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}
        <details>
          <summary>All current checks</summary>
          {plan.checks?.map((check) => (
            <Check key={check.id} check={check} />
          ))}
        </details>
      </>
    ),
    [plan, state.itemId, message, content.artifact],
  );
  return (
    <div className="plan-view" data-focus={props.focus}>
      <nav className="plan-toolbar" aria-label="Plan views">
        <Button
          variant={view === "overview" ? "secondary" : "ghost"}
          aria-pressed={view === "overview"}
          onClick={() => update({ view: "overview" })}
        >
          Overview
        </Button>
        <Button
          variant={view === "work" ? "secondary" : "ghost"}
          aria-pressed={view === "work"}
          onClick={() => update({ view: "work" })}
        >
          Work items
        </Button>
      </nav>
      <div className="plan-page" hidden={view !== "overview"}>
        <iframe
          ref={iframe}
          className="plan-document"
          title={content.artifact.title}
          srcDoc={html}
          onLoad={observe}
        />
      </div>
      <div
        ref={work}
        className="plan-work"
        hidden={view !== "work"}
        onScroll={() => {
          if (props.active && view === "work")
            update({ workScrollY: work.current?.scrollTop ?? 0 });
        }}
      >
        {workItems}
      </div>
    </div>
  );
}
export function PlanView(props: TabProps) {
  return (
    <PublishedContent artifact={props.artifact}>
      {(content) => <PlanContent {...props} content={content} />}
    </PublishedContent>
  );
}
