import { useEffect, useMemo, useRef, useState } from "react";
import { decode } from "@irudd-scope/protocol";
import { planItemPacket, readPlan, type PlanDocument } from "@irudd-scope/protocol/plan";
import type { ArtifactContent } from "../../bridge.ts";
import type { TabProps } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { Button } from "../../renderer/components/ui/button.tsx";
import { PlanTabState } from "./contract.ts";
import { planHtml } from "./document.ts";
import { useDocumentScroll } from "./document-scroll.ts";
import { Check, ProposalContext, RetainedTarget } from "./retained-target.tsx";

function Records({ plan, inspect }: { plan: PlanDocument; inspect: (id: string) => void }) {
  if (!plan.bases?.length) return <p>No agreement or evidence recorded.</p>;
  return (
    <section className="plan-records">
      <h2>Retained proposals</h2>
      <p>
        Agreement and evidence refer to these proposals. Assess their applicability to the current
        proposal.
      </p>
      {plan.bases.map((basis) => (
        <section key={basis.id}>
          <Button variant="outline" onClick={() => inspect(basis.id)}>
            Inspect proposal from revision {basis.revision}
          </Button>
          <ProposalContext proposal={basis.proposal} />
          {!!basis.proposal.checks?.length && (
            <details className="plan-check">
              <summary>Proposal checks</summary>
              {basis.proposal.checks.map((check) => (
                <Check key={check.id} check={check} />
              ))}
            </details>
          )}
          {!plan.agreements?.some((record) => record.basisId === basis.id) &&
            !plan.evidence?.some((record) => record.basisId === basis.id) && (
              <p>No agreement or evidence recorded.</p>
            )}
          {(plan.agreements ?? [])
            .filter((x) => x.basisId === basis.id)
            .map((record) => (
              <div key={record.id}>
                <h3>Agreement</h3>
                <p>{record.note}</p>
                <ul aria-label="Agreement targets">
                  {record.targetIds.map((id) => (
                    <li key={id}>
                      <RetainedTarget id={id} proposal={basis.proposal} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {(plan.evidence ?? [])
            .filter((x) => x.basisId === basis.id)
            .map((record) => (
              <details className="plan-check" key={record.id}>
                <summary>
                  {basis.proposal.checks?.find((x) => x.id === record.checkId)?.label}:{" "}
                  {record.result} on recorded proposal
                </summary>
                <h4>Expected</h4>
                <p>{record.expected}</p>
                <h4>Observed</h4>
                <p>{record.observed}</p>
                <h4>Implementation</h4>
                <p>{record.implementation}</p>
                <h4>Conditions</h4>
                <p>{record.conditions}</p>
                {record.references?.map((reference, index) => (
                  <p key={index}>{reference}</p>
                ))}
                {basis.proposal.checks
                  ?.filter((x) => x.id === record.checkId)
                  .map((check) => (
                    <Check key={check.id} check={check} />
                  ))}
              </details>
            ))}
        </section>
      ))}
    </section>
  );
}

function PlanContent({ content, ...props }: TabProps & { content: ArtifactContent }) {
  const plan = useMemo(() => readPlan(content.bytes), [content.bytes]);
  const owner = props.context.content;
  const state = decode(
    PlanTabState,
    owner
      ? {
          version: 1,
          data: { ...(props.tab.state.data.plan as object), artifactId: content.artifact.id },
        }
      : props.tab.state,
  ).data;
  const stateRef = useRef(state);
  stateRef.current = state;
  const iframe = useRef<HTMLIFrameElement>(null);
  const work = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  const view = state.view ?? "overview";
  const basis = plan.bases?.find((x) => x.id === state.basisId);
  const html = useMemo(() => planHtml(basis?.proposal ?? plan), [plan, basis]);
  const item = plan.items?.find((x) => x.id === state.itemId) ?? plan.items?.[0];
  const packet = useMemo(
    () =>
      item
        ? planItemPacket(
            plan,
            item.id,
            content.artifact,
            owner
              ? {
                  ownerDeviceId: owner.ownerDeviceId,
                  sourceTabId: owner.sourceTabId,
                  sourceVersion: owner.sourceVersion,
                }
              : undefined,
          )
        : undefined,
    [plan, item, content.artifact, owner],
  );
  const update = (patch: Partial<typeof state>) => {
    const data = Object.fromEntries(
      Object.entries({ ...stateRef.current, ...patch }).filter(([, value]) => value !== undefined),
    );
    stateRef.current = decode(PlanTabState, { version: 1, data }).data;
    if (owner) {
      const { artifactId: _artifact, ...reading } = data;
      props.context.updateState({ version: 1, data: { ...props.tab.state.data, plan: reading } });
    } else props.context.updateState({ version: 1, data });
  };
  const observe = useDocumentScroll(
    iframe,
    props.active && view === "overview",
    `${content.artifact.revision}:${basis?.id ?? "current"}`,
    basis ? (state.basisScrollY ?? 0) : (state.scrollY ?? 0),
    (y) => {
      update(basis ? { basisScrollY: y } : { scrollY: y });
    },
  );
  useEffect(() => {
    if (work.current) work.current.scrollTop = stateRef.current.workScrollY ?? 0;
  }, []);
  function inspect(id: string) {
    update({ basisId: id, basisScrollY: 0, view: "overview" });
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
      setMessage("Work item copied.");
    } catch {
      setMessage("Could not copy. Use the retrieval command below.");
    }
  }
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
          onClick={() => update({ view: "work", basisId: undefined })}
        >
          Work items
        </Button>
        {view === "overview" && basis && (
          <>
            <span>Recorded proposal, revision {basis.revision}</span>
            <Button variant="outline" onClick={() => update({ basisId: undefined })}>
              Current proposal
            </Button>
          </>
        )}
      </nav>
      <div className="plan-page" hidden={view !== "overview"}>
        <iframe
          ref={iframe}
          className="plan-document"
          title={
            basis ? `Recorded proposal from revision ${basis.revision}` : content.artifact.title
          }
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
        <div className="plan-item-list" aria-label="Work items">
          {plan.items?.map((entry) => (
            <Button
              key={entry.id}
              variant={item?.id === entry.id ? "secondary" : "outline"}
              aria-pressed={item?.id === entry.id}
              onClick={() => update({ itemId: entry.id })}
            >
              {entry.title}
            </Button>
          ))}
        </div>
        {item && packet ? (
          <article>
            <h1>{item.title}</h1>
            <p>{item.outcome}</p>
            <Button variant="outline" onClick={() => void copy()}>
              Copy work item
            </Button>
            <p role="status">{message}</p>
            <code className="plan-command">{packet.retrieval.item}</code>
            {item.context && <p>{item.context}</p>}
            {plan.context && <p>{plan.context}</p>}
            {!![...(plan.constraints ?? []), ...(item.constraints ?? [])].length && (
              <>
                <h2>Constraints</h2>
                <ul>
                  {[...(plan.constraints ?? []), ...(item.constraints ?? [])].map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            {!!plan.questions?.length && (
              <>
                <h2>Unresolved questions</h2>
                <ul>
                  {plan.questions.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            <h2>Owned checks</h2>
            {packet.ownedChecks.length ? (
              packet.ownedChecks.map((check) => <Check key={check.id} check={check} />)
            ) : (
              <p>No completion checks defined yet.</p>
            )}
            {!!packet.prerequisites.length && (
              <>
                <h2>Prerequisites</h2>
                {packet.prerequisites.map((entry) => (
                  <section key={entry.item.id}>
                    <h3>{entry.item.title}</h3>
                    <p>{entry.item.outcome}</p>
                    {entry.checks.map((check) => (
                      <Check key={check.id} check={check} />
                    ))}
                    <p>
                      {entry.recordedEvidence.length} recorded results. Inspect the recorded
                      proposal below before reusing them.
                    </p>
                  </section>
                ))}
              </>
            )}
            <details>
              <summary>Related context</summary>
              {packet.relatedContext.goals.map((goal) => (
                <p key={goal.id}>{goal.outcome}</p>
              ))}
              {packet.relatedContext.visuals.map((visual) => (
                <p key={visual.id}>{visual.commitment}</p>
              ))}
              {packet.relatedContext.checks.map((check) => (
                <Check key={check.id} check={check} />
              ))}
            </details>
          </article>
        ) : (
          <p>
            No work items defined yet. Read the overview and discuss unresolved choices in chat.
          </p>
        )}
        <Records plan={plan} inspect={inspect} />
        <details>
          <summary>All current checks</summary>
          {plan.checks?.map((check) => (
            <Check key={check.id} check={check} />
          ))}
        </details>
      </div>
    </div>
  );
}
export function PlanView(props: TabProps) {
  return (
    <PublishedContent artifact={props.artifact} content={props.context.content}>
      {(content) => <PlanContent {...props} content={content} />}
    </PublishedContent>
  );
}
