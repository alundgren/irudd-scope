import { readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import {
  addEvidence,
  decodePlan,
  nextPlanItem,
  planItemList,
  planItemPacket,
  readPlan,
  setItemDone,
  type PlanDocument,
} from "@irudd-scope/protocol/plan";

export const PlanGuide = {
  planning: {
    beforePresentation:
      "Before showing or publishing the first proposal, send a scout for a quick technical feasibility check against the current code. Check the proposed outcome, main technical assumptions and existing limits without implementing the feature. The drafting agent checks the findings and addresses problems before presenting.",
    afterAgreement:
      "After the person agrees on the plan, have an independent technical reviewer use its own scout to check the work item breakdown against the code before implementation. Check that the items work together, including dependencies, shared contracts, integration ownership and completion checks through real entry points. The reviewer makes the assessment.",
    revisions:
      "Fix issues within the agreed plan and have the reviewer recheck affected items. If a fix changes an agreed outcome, constraint or acceptance criterion, pause affected work and discuss the problem and proposed change with the person. Revise together until agreed, then review the revised breakdown before starting that work. Reviewer approval is not the person's agreement.",
    presentation:
      "Keep the existing plan format. Keep technical lookup details in agent context and item context or constraints. Explain problems and choices to the person in plain words without file names, line numbers or review reports.",
    delegation:
      "Use the coding session's delegation tools and scout/reviewer launch rules, including model-settings when available. Report unavailable delegation instead of silently skipping a check. Scope does not launch agents.",
  },
  workflow:
    "Planning agents draft and revise the whole plan with plan read and plan publish. Implementing agents never need the whole document: plan next NAME returns a short item list and the packet for the first item that is not done and whose dependencies are done; plan item NAME ITEM_ID returns one packet. Build the item, record evidence for each of its checks, then run plan done NAME ITEM_ID. Mark an item done only when its checks have current evidence.",
  publish:
    "plan publish NAME PLAN.json OVERVIEW.html creates a named permanent JSON plan. To replace it, read it first and pass --expected-revision REVISION; the document you publish replaces the stored one, including doneItemIds and evidence. Zero means create only. Publication is not agreement; agreement happens in conversation.",
  read: "plan read NAME returns artifact metadata and the exact document. plan items NAME lists every item with id, title, done and dependsOn. plan next NAME adds the next item's packet. plan item NAME ITEM_ID returns the item, its checks with their evidence state, goals, plan context and constraints, dependencies as id/title/done, related visuals and the overview HTML. plan content NAME --output NEW_FILE.html exports authored HTML without modification.",
  progress:
    "plan evidence NAME CHECK_ID --result passed|failed|blocked --observed TEXT --implementation TEXT --conditions TEXT [--reference TEXT ...] adds a result. The newest result for a check counts. plan done NAME ITEM_ID and plan reopen NAME ITEM_ID set or clear done. These commands read the current revision and publish only their change; a concurrent change fails instead of being overwritten. Evidence records a fingerprint of the check; if the check's expectation, conditions, method or kind changes, its evidence becomes stale. When a publish changes a done item's outcome or owned checks, the item is no longer done.",
  document: {
    version: 2,
    title: "Required title",
    overviewHtml: "Inserted from OVERVIEW.html",
    context: "Optional project context",
    constraints: [],
    questions: [],
    goals: [{ id: "goal", outcome: "Observable outcome" }],
    visuals: [
      {
        id: "visual",
        anchor: "scenario",
        commitment: "What this visual proposes",
        goalIds: ["goal"],
        checkIds: ["check"],
      },
    ],
    checks: [
      {
        id: "check",
        label: "Short label",
        goalIds: ["goal"],
        expectation: "Complete expected result",
        conditions: "Complete preconditions",
        method: "Complete procedure",
        kind: "agent",
        placement: "overview",
      },
    ],
    items: [
      {
        id: "item",
        title: "Work item",
        outcome: "One coherent outcome",
        context: "Implementation context",
        goalIds: ["goal"],
        checkIds: ["check"],
        dependsOn: [],
        constraints: [],
      },
    ],
    doneItemIds: [],
    evidence: [
      {
        id: "evidence-1",
        checkId: "check",
        checkFingerprint: "Set by plan evidence",
        result: "passed | failed | blocked",
        observed: "Actual behavior",
        implementation: "Commit or build",
        conditions: "Actual test conditions",
        references: ["Evidence location"],
      },
    ],
  },
  bindings:
    "window.scopePlan.data is injected before authored scripts. data-plan-goal=ID fills a goal outcome; data-plan-check=ID fills its expectation; data-plan-procedure=CHECK_ID provides a folded full Test procedure. data-plan-checks=VISUAL_ID lists canonical checks in explicit order. Author visual check interactions freely and keep procedures accessible.",
  style:
    "Use dark neutral authored HTML, clear whole-scenario boundaries, purposeful color and visual conditions/action/results throughout checks. Native controls follow Scope appearance. Keep discussion in chat. Do not infer approval or verification from publication.",
  limits:
    "32 MiB total; 2,000 records per collection. Reads and progress commands require the desktop online. Same-version hubs can queue explicit revision publications; queued is not delivered. Older hubs need a separate update before accepting JSON. Legacy add --plan HTML creates ordinary HTML. Generic update cannot overwrite structured plans.",
};

async function file(path: string, signal: AbortSignal) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CONTENT_BYTES)
    throw new Error("Choose a file no larger than 32 MiB.");
  return readFile(path, { signal });
}
function expectedRevision(value?: string): number {
  if (
    value === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new Error("Provide --expected-revision with the revision you read, or 0 to create.");
  return Number(value);
}
export type PlanOptions = {
  "expected-revision"?: string;
  output?: string;
  result?: string;
  observed?: string;
  implementation?: string;
  conditions?: string;
  reference?: string[];
};
export async function planCommand(
  client: ScopeClient,
  positionals: string[],
  options: PlanOptions,
  signal: AbortSignal,
) {
  const [, action, argument, extra, overview] = positionals;
  if (!argument) throw new Error("Provide a plan name. Use plan guide.");
  const name = decode(ArtifactName, argument);
  if (action === "publish") {
    if (!extra || !overview) throw new Error("Use plan publish NAME PLAN.json OVERVIEW.html.");
    const plan = decodePlan({
      ...JSON.parse((await file(extra, signal)).toString("utf8")),
      overviewHtml: (await file(overview, signal)).toString("utf8"),
    });
    const revision = expectedRevision(options["expected-revision"] ?? "0");
    // updateBase permits offline replacement only from metadata already observed by this hub.
    const current = revision ? await client.updateBase(name) : undefined;
    if (current && (current.kind !== "plan" || current.mediaType !== "application/json"))
      throw new Error("This name does not belong to a structured plan. Choose a new name.");
    return publish(client, current?.id ?? randomUUID(), name, plan, revision, signal);
  }
  const artifact = await client.named(name);
  const bytes = await client.content(artifact.id, artifact.revision, signal);
  if (action === "content" && artifact.mediaType === "text/html") {
    if (!options.output) throw new Error("plan content requires --output with a new file.");
    await writeFile(options.output, bytes, { flag: "wx" });
    return { name, title: artifact.title, output: options.output };
  }
  if (artifact.kind !== "plan" || artifact.mediaType !== "application/json")
    throw new Error(
      "This name does not belong to a structured plan. Legacy plans are ordinary HTML.",
    );
  const document = readPlan(bytes);
  if (action === "read") return { artifact, document };
  if (action === "items") return { artifact, items: planItemList(document) };
  if (action === "next") {
    const next = nextPlanItem(document);
    const finished = !!document.items?.every((x) => document.doneItemIds?.includes(x.id));
    return {
      artifact,
      items: planItemList(document),
      next: next ? planItemPacket(document, next.id, artifact) : null,
      ...(next
        ? {}
        : { message: finished ? "Every work item is done." : "No work item is ready." }),
    };
  }
  if (action === "item") {
    if (!extra) throw new Error("Use plan item NAME ITEM_ID.");
    return planItemPacket(document, extra, artifact);
  }
  if (action === "content") {
    if (!options.output) throw new Error("plan content requires --output with a new file.");
    await writeFile(options.output, document.overviewHtml, { flag: "wx" });
    return { name, title: artifact.title, output: options.output };
  }
  if (action === "done" || action === "reopen") {
    if (!extra) throw new Error(`Use plan ${action} NAME ITEM_ID.`);
    const next = setItemDone(document, extra, action === "done");
    const receipt = await publish(client, artifact.id, name, next, artifact.revision, signal);
    return { name, item: extra, done: action === "done", receipt: brief(receipt) };
  }
  if (action === "evidence") {
    if (!extra) throw new Error("Use plan evidence NAME CHECK_ID with --result and details.");
    const result = options.result;
    if (result !== "passed" && result !== "failed" && result !== "blocked")
      throw new Error("Provide --result passed, failed or blocked.");
    for (const flag of ["observed", "implementation", "conditions"] as const)
      if (!options[flag]) throw new Error(`Provide --${flag}.`);
    const next = addEvidence(document, {
      checkId: extra,
      result,
      observed: options.observed!,
      implementation: options.implementation!,
      conditions: options.conditions!,
      ...(options.reference?.length ? { references: options.reference } : {}),
    });
    const receipt = await publish(client, artifact.id, name, next, artifact.revision, signal);
    return {
      name,
      check: extra,
      result,
      evidence: next.evidence!.at(-1)!.id,
      receipt: brief(receipt),
    };
  }
  throw new Error("Use plan guide for supported commands.");
}
function brief(receipt: Awaited<ReturnType<typeof publish>>) {
  return "revision" in receipt
    ? { revision: receipt.revision }
    : { queued: true, expiresAt: receipt.expiresAt };
}
function publish(
  client: ScopeClient,
  id: string,
  name: string,
  plan: PlanDocument,
  revision: number,
  signal: AbortSignal,
) {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  if (bytes.byteLength > MAX_CONTENT_BYTES) throw new Error("Plan exceeds 32 MiB.");
  return client.publishOrQueue(
    id,
    {
      name,
      title: plan.title,
      kind: "plan",
      fileName: `${name}.json`,
      mediaType: "application/json",
      expectedRevision: revision,
    },
    bytes,
    signal,
  );
}
