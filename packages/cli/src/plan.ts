import { readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import {
  capturePlanBasis,
  decodePlan,
  planItemPacket,
  readPlan,
  validatePlanUpdate,
  type PlanDocument,
} from "@irudd-scope/protocol/plan";

export const PlanGuide = {
  publish:
    "plan publish NAME PLAN.json OVERVIEW.html creates a named permanent JSON plan. To replace, first read it, preserve bases and records, then pass --expected-revision REVISION. Zero means create only. Publication is not agreement.",
  read: "plan read NAME returns artifact metadata and the exact document. plan item NAME ITEM_ID returns owned checks, prerequisites, related context and retained evidence separately. plan content NAME --output NEW_FILE.html exports authored HTML without modification.",
  basis:
    "plan capture-basis NAME BASIS_ID --expected-revision REVISION captures the exact current proposal and publishes it with a revision guard. It records no agreement. Read again, add agreement/evidence referencing that basisId and publish with the new expected revision. Basis IDs are immutable and retained. Records are immutable; explicit removedRecordIds removes a record before a correction with a new ID.",
  document: {
    version: 1,
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
    bases: [],
    agreements: [],
    evidence: [],
  },
  records: {
    agreement: {
      id: "agreement",
      basisId: "discussed",
      targetIds: ["goal"],
      note: "Actual conversational agreement",
    },
    evidence: {
      id: "result",
      basisId: "tested",
      checkId: "check",
      expected: "Expected behavior in the tested context",
      observed: "Actual behavior",
      implementation: "Commit or build",
      conditions: "Actual test conditions",
      result: "passed | failed | blocked",
      references: ["Evidence location"],
    },
  },
  bindings:
    "window.scopePlan.data is injected before authored scripts. data-plan-goal=ID fills a goal outcome; data-plan-check=ID fills its expectation; data-plan-procedure=CHECK_ID provides a folded full Test procedure. data-plan-checks=VISUAL_ID lists canonical checks in explicit order. Author visual check interactions freely and keep procedures accessible.",
  style:
    "Use dark neutral authored HTML, clear whole-scenario boundaries, purposeful color and visual conditions/action/results throughout checks. Native controls follow Scope appearance. Keep discussion in chat. Do not infer approval or verification from publication.",
  limits:
    "32 MiB total, including retained bases; 2,000 records per collection. Reads and basis capture require the desktop online. Same-version hubs can queue explicit revision publications; queued is not delivered. Older hubs need a separate update before accepting JSON. Legacy add --plan HTML creates ordinary HTML. Generic update cannot overwrite structured plans.",
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
export async function planCommand(
  client: ScopeClient,
  positionals: string[],
  options: { output?: string; "expected-revision"?: string },
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
  if (action === "item") return planItemPacket(document, extra, artifact);
  if (action === "content") {
    if (!options.output) throw new Error("plan content requires --output with a new file.");
    await writeFile(options.output, document.overviewHtml, { flag: "wx" });
    return { name, title: artifact.title, output: options.output };
  }
  if (action === "capture-basis") {
    const revision = expectedRevision(options["expected-revision"]);
    if (revision !== artifact.revision)
      throw new Error("Artifact changed. Read the current revision before capturing a basis.");
    const captured = capturePlanBasis(document, revision, extra);
    validatePlanUpdate(captured, document, revision);
    return publish(client, artifact.id, name, captured, revision, signal);
  }
  throw new Error("Use plan guide for supported commands.");
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
  if (bytes.byteLength > MAX_CONTENT_BYTES)
    throw new Error("Plan exceeds 32 MiB. Retained material was not dropped.");
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
