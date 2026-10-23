import { Schema } from "effect";
import { decode, MAX_CONTENT_BYTES, Revision, ScopeError } from "./index.ts";

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262144));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const List = <S extends Schema.Top>(schema: S) =>
  Schema.Array(schema).check(Schema.isMaxLength(2000));
const Ids = List(Id);
const Strings = List(Text);
const Goal = Schema.Struct({ id: Id, outcome: Text });
const Visual = Schema.Struct({ id: Id, anchor: Id, commitment: Text, goalIds: Ids, checkIds: Ids });
const Check = Schema.Struct({
  id: Id,
  label: Label,
  goalIds: Ids,
  expectation: Text,
  conditions: Text,
  method: Text,
  kind: Schema.Literals(["agent", "human"]),
  placement: Schema.optionalKey(Schema.Literals(["overview", "work"])),
});
const Item = Schema.Struct({
  id: Id,
  title: Label,
  outcome: Text,
  context: Schema.optionalKey(Text),
  goalIds: Ids,
  checkIds: Ids,
  dependsOn: Ids,
  constraints: Schema.optionalKey(Strings),
});
export const PlanProposal = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  overviewHtml: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CONTENT_BYTES)),
  context: Schema.optionalKey(Text),
  constraints: Schema.optionalKey(Strings),
  questions: Schema.optionalKey(Strings),
  goals: Schema.optionalKey(List(Goal)),
  visuals: Schema.optionalKey(List(Visual)),
  checks: Schema.optionalKey(List(Check)),
  items: Schema.optionalKey(List(Item)),
});
export type PlanProposal = typeof PlanProposal.Type;
const Basis = Schema.Struct({ id: Id, revision: Revision, proposal: PlanProposal });
const Agreement = Schema.Struct({ id: Id, basisId: Id, targetIds: Ids, note: Text });
const Evidence = Schema.Struct({
  id: Id,
  basisId: Id,
  checkId: Id,
  expected: Text,
  observed: Text,
  implementation: Text,
  conditions: Text,
  result: Schema.Literals(["passed", "failed", "blocked"]),
  references: Schema.optionalKey(Strings),
});
export const PlanDocument = Schema.Struct({
  version: Schema.Literal(1),
  ...PlanProposal.fields,
  bases: Schema.optionalKey(List(Basis)),
  agreements: Schema.optionalKey(List(Agreement)),
  evidence: Schema.optionalKey(List(Evidence)),
  removedRecordIds: Schema.optionalKey(Ids),
});
export type PlanDocument = typeof PlanDocument.Type;
export type PlanCheck = typeof Check.Type;
export type PlanItem = typeof Item.Type;
export type PlanBasis = typeof Basis.Type;

function invalid(message: string): never {
  throw new ScopeError(400, message);
}
function unique(ids: readonly string[], label: string) {
  if (new Set(ids).size !== ids.length) invalid(`Duplicate ${label}.`);
}
function references(ids: readonly string[], available: Set<string>, label: string) {
  unique(ids, label);
  for (const id of ids) if (!available.has(id)) invalid(`Unknown ${label}: ${id}.`);
}
function validateProposal(plan: PlanProposal) {
  const goals = plan.goals ?? [],
    visuals = plan.visuals ?? [],
    checks = plan.checks ?? [],
    items = plan.items ?? [];
  const all = [...goals, ...visuals, ...checks, ...items].map((x) => x.id);
  unique(all, "proposal ID");
  unique(
    visuals.map((x) => x.anchor),
    "visual anchor",
  );
  const goalIds = new Set(goals.map((x) => x.id));
  const checkIds = new Set(checks.map((x) => x.id));
  const itemIds = new Set(items.map((x) => x.id));
  for (const record of [...visuals, ...checks, ...items])
    references(record.goalIds, goalIds, "goal");
  for (const record of [...visuals, ...items]) {
    references(record.checkIds, checkIds, "check");
    for (const check of checks.filter((x) => record.checkIds.includes(x.id))) {
      if (!check.goalIds.every((id) => record.goalIds.includes(id)))
        invalid(`Check ${check.id} has goals missing from ${record.id}.`);
    }
  }
  for (const visual of visuals) {
    if (!new RegExp(`\\bid\\s*=\\s*["']${visual.anchor}["']`).test(plan.overviewHtml))
      invalid(`Visual ${visual.id} needs HTML anchor ${visual.anchor}.`);
    if (checks.some((x) => x.placement === "work" && visual.checkIds.includes(x.id)))
      invalid(`Work-only checks cannot be placed in visual ${visual.id}.`);
  }
  for (const check of checks) {
    if (check.placement === "work" && !items.some((x) => x.checkIds.includes(check.id)))
      invalid(`Work-only check ${check.id} needs an owning item.`);
  }
  for (const item of items) references(item.dependsOn, itemIds, "dependency");
  const pending = new Set(itemIds),
    done = new Set<string>();
  while (pending.size) {
    const ready = items.filter((x) => pending.has(x.id) && x.dependsOn.every((id) => done.has(id)));
    if (!ready.length) invalid("Work item dependencies contain a cycle.");
    for (const item of ready) {
      pending.delete(item.id);
      done.add(item.id);
    }
  }
  return new Set(all);
}

export function decodePlan(input: unknown): PlanDocument {
  try {
    const plan = decode(PlanDocument, input);
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_CONTENT_BYTES)
      invalid("Plan exceeds 32 MiB. Retained records were not discarded.");
    validateProposal(plan);
    const bases = plan.bases ?? [],
      agreements = plan.agreements ?? [],
      evidence = plan.evidence ?? [];
    unique(
      [...bases, ...agreements, ...evidence].map((x) => x.id),
      "record ID",
    );
    unique(plan.removedRecordIds ?? [], "removed record ID");
    const targets = new Map(
      bases.map((basis) => {
        if (basis.revision < 1) invalid("A basis must identify a published revision.");
        return [basis.id, validateProposal(basis.proposal)] as const;
      }),
    );
    for (const record of [...agreements, ...evidence]) {
      const basis = bases.find((x) => x.id === record.basisId);
      if (!basis) invalid(`Unknown basis: ${record.basisId}.`);
      if ("targetIds" in record) {
        if (!record.targetIds.length) invalid("Agreement needs at least one target.");
        references(record.targetIds, targets.get(basis.id)!, "agreement target");
      } else if (!basis.proposal.checks?.some((x) => x.id === record.checkId))
        invalid(`Unknown evidence check in basis ${basis.id}: ${record.checkId}.`);
    }
    if ([...bases, ...agreements, ...evidence].some((x) => plan.removedRecordIds?.includes(x.id)))
      invalid("A removed record ID cannot also name a retained record.");
    return plan;
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(
      400,
      `Invalid plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export function readPlan(bytes: Uint8Array): PlanDocument {
  if (bytes.byteLength > MAX_CONTENT_BYTES) invalid("Plan exceeds 32 MiB.");
  try {
    return decodePlan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(400, "Plan content must be valid UTF-8 JSON.");
  }
}
export function proposalOf(plan: PlanDocument): PlanProposal {
  const {
    version: _version,
    bases: _bases,
    agreements: _agreements,
    evidence: _evidence,
    removedRecordIds: _removed,
    ...proposal
  } = plan;
  return proposal;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validatePlanUpdate(next: PlanDocument, previous?: PlanDocument, revision = 0) {
  for (const basis of next.bases ?? []) {
    const old = previous?.bases?.find((x) => x.id === basis.id);
    if (
      old
        ? canonical(old) !== canonical(basis)
        : !previous ||
          basis.revision !== revision ||
          canonical(basis.proposal) !== canonical(proposalOf(previous))
    )
      throw new ScopeError(
        409,
        "A basis must preserve the exact proposal at its source revision. Capture it from a current read.",
      );
  }
  for (const basis of previous?.bases ?? [])
    if (!next.bases?.some((x) => x.id === basis.id))
      throw new ScopeError(409, "Retained bases cannot be removed.");
  for (const key of ["agreements", "evidence"] as const) {
    for (const record of previous?.[key] ?? []) {
      const replacement = next[key]?.find((x) => x.id === record.id);
      if (
        replacement
          ? canonical(record) !== canonical(replacement)
          : !next.removedRecordIds?.includes(record.id)
      )
        throw new ScopeError(
          409,
          "Preserve recorded agreement and evidence. Explicitly list removedRecordIds to remove a record; use a new ID for a correction.",
        );
    }
  }
  for (const id of previous?.removedRecordIds ?? []) {
    if (!next.removedRecordIds?.includes(id))
      throw new ScopeError(409, "Preserve removed record IDs.");
  }
}
export function capturePlanBasis(plan: PlanDocument, revision: number, id: string): PlanDocument {
  if (plan.bases?.some((x) => x.id === id)) throw new ScopeError(409, "Choose a new basis ID.");
  return decodePlan({
    ...plan,
    bases: [...(plan.bases ?? []), { id, revision, proposal: proposalOf(plan) }],
  });
}

export function planItemPacket(
  plan: PlanDocument,
  itemId: string,
  artifact: { name?: string; id: string; revision: number },
) {
  const item = plan.items?.find((x) => x.id === itemId);
  if (!item) throw new ScopeError(404, "Work item not found.");
  const prerequisites = new Set<string>();
  const pending = [...item.dependsOn];
  while (pending.length) {
    const id = pending.pop()!;
    if (prerequisites.has(id)) continue;
    prerequisites.add(id);
    pending.push(...plan.items!.find((x) => x.id === id)!.dependsOn);
  }
  const evidenceFor = (ids: readonly string[]) =>
    (plan.evidence ?? []).filter((x) => ids.includes(x.checkId));
  const prerequisiteItems = (plan.items ?? [])
    .filter((x) => prerequisites.has(x.id))
    .map((entry) => ({
      item: entry,
      checks: (plan.checks ?? []).filter((x) => entry.checkIds.includes(x.id)),
      recordedEvidence: evidenceFor(entry.checkIds),
    }));
  const goals = new Set([...item.goalIds, ...prerequisiteItems.flatMap((x) => x.item.goalIds)]);
  const ownedChecks = (plan.checks ?? []).filter((x) => item.checkIds.includes(x.id));
  const relevantItems = new Set([item.id, ...prerequisites]);
  const relevantChecks = new Set([
    ...item.checkIds,
    ...prerequisiteItems.flatMap((x) => x.item.checkIds),
  ]);
  const visuals = (plan.visuals ?? []).filter(
    (x) => x.checkIds.some((id) => relevantChecks.has(id)) || x.goalIds.some((id) => goals.has(id)),
  );
  const targets = new Set([
    ...goals,
    ...relevantItems,
    ...relevantChecks,
    ...visuals.map((x) => x.id),
  ]);
  const historicalBasisIds = new Set(
    (plan.bases ?? [])
      .filter((x) => x.proposal.items?.some((old) => relevantItems.has(old.id)))
      .map((x) => x.id),
  );
  const agreements = (plan.agreements ?? []).filter(
    (x) => x.targetIds.some((id) => targets.has(id)) || historicalBasisIds.has(x.basisId),
  );
  // Historical checks may have been removed or renamed in the current proposal.
  const bases = (plan.bases ?? []).filter(
    (x) =>
      x.proposal.items?.some((old) => relevantItems.has(old.id)) ||
      agreements.some((a) => a.basisId === x.id),
  );
  const basisIds = new Set(bases.map((x) => x.id));
  const evidence = (plan.evidence ?? []).filter(
    (x) => relevantChecks.has(x.checkId) || basisIds.has(x.basisId),
  );
  for (const basis of plan.bases ?? [])
    if (evidence.some((x) => x.basisId === basis.id) && !basisIds.has(basis.id)) bases.push(basis);
  return {
    version: 1,
    artifact,
    item,
    ownedChecks,
    prerequisites: prerequisiteItems,
    relatedContext: {
      context: plan.context ?? "",
      constraints: plan.constraints ?? [],
      questions: plan.questions ?? [],
      goals: (plan.goals ?? []).filter((x) => goals.has(x.id)),
      visuals,
      checks: (plan.checks ?? []).filter(
        (x) => !relevantChecks.has(x.id) && x.goalIds.some((id) => goals.has(id)),
      ),
    },
    recorded: {
      agreements,
      evidence,
      bases,
      applicability:
        "Records refer to retained proposals. Assess applicability explicitly; they do not verify the current proposal automatically.",
    },
    overviewHtml: plan.overviewHtml,
    retrieval: {
      read: `irudd-scope plan read ${artifact.name ?? artifact.id}`,
      content: `irudd-scope plan content ${artifact.name ?? artifact.id} --output overview.html`,
    },
  };
}
