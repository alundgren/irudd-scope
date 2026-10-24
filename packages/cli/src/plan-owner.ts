import { readFile, stat, writeFile } from "node:fs/promises";
import { ArtifactId, decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { GuestTarget, type GuestAction } from "@irudd-scope/protocol/guest-operation";
import {
  capturePlanBasis,
  decodePlan,
  planItemPacket,
  planRetrieval,
  readPlan,
  validatePlanUpdate,
} from "@irudd-scope/protocol/plan";

export type GuestPlanOptions = {
  output?: string;
  "expected-revision"?: string;
  "expected-source-version"?: string;
  "owner-device"?: string;
  "source-tab"?: string;
};
function version(value: string | undefined, flag: string) {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`Provide --${flag} with the value from the owner plan read.`);
  return Number(value);
}
async function file(path: string | undefined, signal: AbortSignal) {
  if (!path)
    throw new Error(
      "Use plan publish ARTIFACT_ID PLAN.json OVERVIEW.html with owner flags and expected versions.",
    );
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CONTENT_BYTES)
    throw new Error("Choose a file no larger than 32 MiB.");
  return readFile(path, { signal, encoding: "utf8" });
}
export async function guestPlanCommand(
  client: ScopeClient,
  positionals: string[],
  options: GuestPlanOptions,
  signal: AbortSignal,
) {
  const [, action, argument, extra, overview] = positionals;
  const id = decode(ArtifactId, argument);
  if (!options["owner-device"] || !options["source-tab"])
    throw new Error(
      "Owner-targeted plans require both --owner-device and --source-tab. Use the exact artifact ID, not its local name.",
    );
  const target = decode(GuestTarget, {
    ownerDeviceId: options["owner-device"],
    sourceTabId: options["source-tab"],
  });
  await client.guestCapabilities();
  if (action === "status" || action === "reconcile") {
    const pending = await client.guestPending(target);
    if (!pending) return { target, pending: null };
    if (pending.artifactId !== id)
      throw new Error("The pending operation belongs to another artifact.");
    if (!["capture-basis", "replace-plan"].includes(pending.operation.change.action.kind))
      throw new Error("The pending source change is not a plan write. Resolve it in Scope.");
    const identity = {
      operationId: pending.operation.operationId,
      digest: pending.operation.digest,
    };
    const result =
      action === "status"
        ? { outcome: await client.guestStatus(target, identity) }
        : await client.guestReconcile(target, identity);
    return { target, ...pending, ...result };
  }
  if (!["read", "item", "content", "publish", "capture-basis"].includes(action))
    throw new Error("Use plan guide for supported commands.");
  const source = await client.guestSource(target);
  if (
    !source ||
    source.kind !== "plan" ||
    source.artifact?.id !== id ||
    source.artifact.mediaType !== "application/json"
  )
    throw new Error(
      "This owner and source do not identify that structured plan. No local plan was used.",
    );
  const artifact = source.artifact;
  const owner = { ...target, sourceVersion: source.sourceVersion };
  const read = await client.guestRead({ target, revision: artifact.revision });
  if (
    read.artifact.id !== id ||
    read.artifact.revision !== artifact.revision ||
    read.artifact.blob !== artifact.blob
  )
    throw new Error("The owner plan changed while reading. Read it again.");
  const document = readPlan(new TextEncoder().encode(read.content));
  if (action === "read") return { artifact, document, owner };
  if (action === "item") return planItemPacket(document, extra, artifact, owner);
  if (action === "content") {
    if (!options.output) throw new Error("plan content requires --output with a new file.");
    await writeFile(options.output, document.overviewHtml, { flag: "wx" });
    return { artifact, owner, output: options.output };
  }
  const revision = version(options["expected-revision"], "expected-revision");
  const sourceVersion = version(options["expected-source-version"], "expected-source-version");
  if (revision !== artifact.revision || sourceVersion !== source.sourceVersion)
    throw new Error(
      "The owner plan changed. Read its current revision and sourceVersion before writing.",
    );
  let change: GuestAction;
  if (action === "capture-basis") {
    const next = capturePlanBasis(document, revision, extra);
    validatePlanUpdate(next, document, revision);
    change = { kind: "capture-basis", basisId: extra };
  } else {
    const next = decodePlan({
      ...JSON.parse(await file(extra, signal)),
      overviewHtml: await file(overview, signal),
    });
    validatePlanUpdate(next, document, revision);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_CONTENT_BYTES)
      throw new Error("Plan exceeds 32 MiB. Retained material was not dropped.");
    change = { kind: "replace-plan", document: next };
  }
  const status = planRetrieval("status", artifact, target);
  const reconcile = planRetrieval("reconcile", artifact, target);
  let operation;
  try {
    operation = await client.guestPrepare({
      version: 1,
      target,
      expectedRevision: revision,
      expectedSourceVersion: sourceVersion,
      action: change,
    });
    const identity = { operationId: operation.operationId, digest: operation.digest };
    const outcome = await client.guestExecute(target, identity);
    if (outcome.state !== "completed")
      throw new Error(outcome.message ?? `Owner operation is ${outcome.state}.`);
    return { target, ...identity, outcome, recovery: { status, reconcile } };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Owner write failed."} Keep the original input. Do not repeat this write. Inspect saved operation with: ${status}. Then reconcile before a new write: ${reconcile}${operation ? `. Operation ${operation.operationId}, digest ${operation.digest}.` : ""}`,
    );
  }
}
