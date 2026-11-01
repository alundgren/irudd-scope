import { Schema } from "effect";
import { decode, MAX_CONTENT_BYTES, ScopeError } from "./index.ts";

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
const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/));
const Evidence = Schema.Struct({
  id: Id,
  checkId: Id,
  checkFingerprint: Fingerprint,
  result: Schema.Literals(["passed", "failed", "blocked"]),
  observed: Text,
  implementation: Text,
  conditions: Text,
  references: Schema.optionalKey(Strings),
});
export const PlanDocument = Schema.Struct({
  version: Schema.Literal(2),
  ...PlanProposal.fields,
  doneItemIds: Schema.optionalKey(Ids),
  evidence: Schema.optionalKey(List(Evidence)),
});
export type PlanDocument = typeof PlanDocument.Type;
export type PlanCheck = typeof Check.Type;
export type PlanItem = typeof Item.Type;
export type PlanEvidence = typeof Evidence.Type;
export type EvidenceState = PlanEvidence["result"] | "stale" | "none";

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
  if (input && typeof input === "object" && "version" in input && input.version === 1)
    invalid("This plan uses format version 1. Update the irudd-scope CLI and publish again.");
  try {
    const plan = decode(PlanDocument, input);
    if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_CONTENT_BYTES)
      invalid("Plan exceeds 32 MiB.");
    validateProposal(plan);
    unique(plan.doneItemIds ?? [], "done item");
    unique(
      (plan.evidence ?? []).map((x) => x.id),
      "evidence ID",
    );
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
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ScopeError(400, "Plan content must be valid UTF-8 JSON.");
  }
  return decodePlan(input);
}
export function proposalOf(plan: PlanDocument): PlanProposal {
  const { version: _version, doneItemIds: _done, evidence: _evidence, ...proposal } = plan;
  return proposal;
}

/** Detects changed check wording; it is not a security hash. Runs in the renderer too. */
export function checkFingerprint(
  check: Pick<PlanCheck, "expectation" | "conditions" | "method" | "kind">,
) {
  const text = JSON.stringify([check.expectation, check.conditions, check.method, check.kind]);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text))
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

/** The newest record for a check decides its state; a changed check makes it stale. */
export function checkEvidence(plan: PlanDocument, check: PlanCheck) {
  const latest = (plan.evidence ?? []).findLast((x) => x.checkId === check.id);
  const state: EvidenceState = !latest
    ? "none"
    : latest.checkFingerprint === checkFingerprint(check)
      ? latest.result
      : "stale";
  return { state, evidence: state === "stale" || state === "none" ? undefined : latest };
}

/**
 * Applied when a plan is stored. Progress for removed items and checks is dropped, and an item
 * whose outcome or owned checks changed is no longer done.
 */
export function settlePlan(next: PlanDocument, previous?: PlanDocument): PlanDocument {
  const items = new Map((next.items ?? []).map((x) => [x.id, x]));
  const checks = new Set((next.checks ?? []).map((x) => x.id));
  const definition = (plan: PlanDocument, item: PlanItem) =>
    JSON.stringify([
      item.outcome,
      [...item.checkIds].sort().map((id) => {
        const check = plan.checks?.find((x) => x.id === id);
        return check ? checkFingerprint(check) : id;
      }),
    ]);
  const doneItemIds = [...new Set(next.doneItemIds)].filter((id) => {
    const item = items.get(id);
    if (!item) return false;
    const before = previous?.items?.find((x) => x.id === id);
    return !before || definition(previous!, before) === definition(next, item);
  });
  const evidence = (next.evidence ?? []).filter((x) => checks.has(x.checkId));
  const { doneItemIds: _done, evidence: _evidence, ...rest } = next;
  return {
    ...rest,
    ...(doneItemIds.length ? { doneItemIds } : {}),
    ...(evidence.length ? { evidence } : {}),
  };
}

export function setItemDone(plan: PlanDocument, itemId: string, done: boolean): PlanDocument {
  if (!plan.items?.some((x) => x.id === itemId)) throw new ScopeError(404, "Work item not found.");
  const others = (plan.doneItemIds ?? []).filter((id) => id !== itemId);
  return settlePlan({ ...plan, doneItemIds: done ? [...others, itemId] : others });
}

export function addEvidence(
  plan: PlanDocument,
  record: Omit<PlanEvidence, "id" | "checkFingerprint">,
): PlanDocument {
  const check = plan.checks?.find((x) => x.id === record.checkId);
  if (!check) throw new ScopeError(404, "Check not found.");
  let n = (plan.evidence?.length ?? 0) + 1;
  while (plan.evidence?.some((x) => x.id === `evidence-${n}`)) n++;
  return decodePlan({
    ...plan,
    evidence: [
      ...(plan.evidence ?? []),
      { id: `evidence-${n}`, checkFingerprint: checkFingerprint(check), ...record },
    ],
  });
}

type PlanArtifact = { name?: string; id: string; revision: number };
const planRef = (artifact: { id: string; name?: string }) => artifact.name ?? artifact.id;

export function planCommands(artifact: { id: string; name?: string }, itemId = "ITEM_ID") {
  const plan = planRef(artifact);
  return {
    items: `irudd-scope plan items ${plan}`,
    next: `irudd-scope plan next ${plan}`,
    item: `irudd-scope plan item ${plan} ${itemId}`,
    evidence: `irudd-scope plan evidence ${plan} CHECK_ID --result passed|failed|blocked --observed TEXT --implementation TEXT --conditions TEXT`,
    done: `irudd-scope plan done ${plan} ${itemId}`,
    reopen: `irudd-scope plan reopen ${plan} ${itemId}`,
  };
}

export function itemInstruction(artifact: { id: string; name?: string }, item: PlanItem) {
  const commands = planCommands(artifact, item.id);
  return `Implement work item "${item.title}" from Scope plan ${planRef(artifact)}. Read it with: ${commands.item}. Record evidence for each of its checks with: ${commands.evidence}. When it is finished, mark it done with: ${commands.done}`;
}

export function nextItemInstruction(artifact: { id: string; name?: string }) {
  const commands = planCommands(artifact);
  return `Implement the next work item from Scope plan ${planRef(artifact)}. Find and read it with: ${commands.next}. Record evidence for each of its checks with: ${commands.evidence}. When it is finished, mark it done with: ${commands.done}`;
}

export function planItemList(plan: PlanDocument) {
  const done = new Set(plan.doneItemIds);
  return (plan.items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    done: done.has(item.id),
    dependsOn: item.dependsOn,
  }));
}

/** The first item in plan order that is not done and whose dependencies are done. */
export function nextPlanItem(plan: PlanDocument) {
  const done = new Set(plan.doneItemIds);
  return plan.items?.find((x) => !done.has(x.id) && x.dependsOn.every((id) => done.has(id)));
}

export function planItemPacket(plan: PlanDocument, itemId: string, artifact: PlanArtifact) {
  const item = plan.items?.find((x) => x.id === itemId);
  if (!item) throw new ScopeError(404, "Work item not found.");
  const done = new Set(plan.doneItemIds);
  return {
    version: 2,
    artifact: {
      id: artifact.id,
      ...(artifact.name ? { name: artifact.name } : {}),
      revision: artifact.revision,
    },
    item: { ...item, done: done.has(item.id) },
    checks: (plan.checks ?? [])
      .filter((x) => item.checkIds.includes(x.id))
      .map((check) => ({ ...check, ...checkEvidence(plan, check) })),
    goals: (plan.goals ?? []).filter((x) => item.goalIds.includes(x.id)),
    context: plan.context ?? "",
    constraints: plan.constraints ?? [],
    questions: plan.questions ?? [],
    dependencies: item.dependsOn.map((id) => ({
      id,
      title: plan.items!.find((x) => x.id === id)!.title,
      done: done.has(id),
    })),
    visuals: (plan.visuals ?? []).filter((x) =>
      x.checkIds.some((id) => item.checkIds.includes(id)),
    ),
    overviewHtml: plan.overviewHtml,
    commands: planCommands(artifact, item.id),
  };
}
export type PlanItemPacket = ReturnType<typeof planItemPacket>;
