import type { ReactNode } from "react";
import type { PlanCheck, PlanProposal } from "@irudd-scope/protocol/plan";

export function Check({ check, children }: { check: PlanCheck; children?: ReactNode }) {
  return (
    <details className="plan-check">
      <summary>{check.label}</summary>
      <p>{check.expectation}</p>
      <h4>Conditions</h4>
      <p>{check.conditions}</p>
      <h4>Test procedure</h4>
      <p>{check.method}</p>
      <p className="plan-muted">
        {check.kind === "human" ? "Requires human judgment" : "Agent check"}
      </p>
      {children}
    </details>
  );
}

function Goals({ ids, proposal }: { ids: readonly string[]; proposal: PlanProposal }) {
  return (
    <>
      <h4>Goals</h4>
      {ids.map((id) => (
        <p key={id}>{proposal.goals?.find((goal) => goal.id === id)?.outcome}</p>
      ))}
    </>
  );
}

export function ProposalContext({ proposal }: { proposal: PlanProposal }) {
  if (!proposal.context && !proposal.constraints?.length && !proposal.questions?.length)
    return null;
  return (
    <details className="plan-check">
      <summary>Recorded proposal context</summary>
      {proposal.context && <p>{proposal.context}</p>}
      {!!proposal.constraints?.length && (
        <>
          <h4>Constraints</h4>
          <ul>
            {proposal.constraints.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </>
      )}
      {!!proposal.questions?.length && (
        <>
          <h4>Unresolved questions</h4>
          <ul>
            {proposal.questions.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}

export function RetainedTarget({ id, proposal }: { id: string; proposal: PlanProposal }) {
  const check = proposal.checks?.find((entry) => entry.id === id);
  if (check)
    return (
      <Check check={check}>
        <Goals ids={check.goalIds} proposal={proposal} />
        <p>Placement: {check.placement === "work" ? "Work items" : "Overview"}</p>
      </Check>
    );
  const goal = proposal.goals?.find((entry) => entry.id === id);
  if (goal) return <p>{goal.outcome}</p>;
  const item = proposal.items?.find((entry) => entry.id === id);
  const visual = proposal.visuals?.find((entry) => entry.id === id);
  const target = item ?? visual;
  if (!target) return null;
  return (
    <details className="plan-check">
      <summary>{item ? item.title : visual?.commitment}</summary>
      {item && (
        <>
          <h4>Outcome</h4>
          <p>{item.outcome}</p>
          {item.context && (
            <>
              <h4>Context</h4>
              <p>{item.context}</p>
            </>
          )}
          {!!item.constraints?.length && (
            <>
              <h4>Constraints</h4>
              <ul>
                {item.constraints.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            </>
          )}
          <h4>Prerequisites</h4>
          {item.dependsOn.length ? (
            item.dependsOn.map((dependencyId) => {
              const dependency = proposal.items?.find((entry) => entry.id === dependencyId);
              return (
                <p key={dependencyId}>
                  {dependency?.title}: {dependency?.outcome}
                </p>
              );
            })
          ) : (
            <p>No prerequisites.</p>
          )}
        </>
      )}
      {visual && <p>Overview anchor: {visual.anchor}</p>}
      <Goals ids={target.goalIds} proposal={proposal} />
      <h4>{item ? "Owned checks" : "Visual checks"}</h4>
      {target.checkIds.map((checkId) => (
        <RetainedTarget key={checkId} id={checkId} proposal={proposal} />
      ))}
    </details>
  );
}
