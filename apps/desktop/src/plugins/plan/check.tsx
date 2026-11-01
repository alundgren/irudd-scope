import type { ReactNode } from "react";
import type { EvidenceState, PlanCheck } from "@irudd-scope/protocol/plan";

export function Check({
  check,
  label,
  result,
  children,
}: {
  check: PlanCheck;
  label?: string;
  result?: EvidenceState;
  children?: ReactNode;
}) {
  return (
    <details className="plan-check">
      <summary>
        {check.label}
        {label && (
          <span className="plan-evidence" data-result={result}>
            {label}
          </span>
        )}
      </summary>
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
