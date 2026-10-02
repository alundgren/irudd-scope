import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactId, PublicationTabId, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import {
  PublicationsCommand,
  MAX_PUBLICATIONS_REQUEST_BYTES,
} from "@irudd-scope/protocol/publications";

export const PublicationsGuide = {
  purpose:
    "Publish stored HTML or a plan's HTML with the current agent's native Claude Artifact or OpenAI Sites tools. Scope keeps links and exact publication checkpoints. No pull, conflict resolution, automatic sync, provider credentials, or coding-session launch. Read the installed skill's references/outbound-publications.md before publishing.",
  commands:
    "publications read ARTIFACT_ID; publications apply REQUEST.json; publications content ARTIFACT_ID OPERATION_UUID --output NEW_FILE.html. guide works offline; other commands require the desktop online, including through the hub. apply prints a decision and exits 2 for blocked or warning outcomes. Only a successful start permits the provider write.",
  availability:
    "Claude requires the native Artifact tool in a subscription session signed in with /login. Existing Claude updates also require authenticated Share-dialog inspection. Sites requires actual Sites tools in this host and private deployment enforcement. Ordinary Codex terminal sessions do not automatically have Sites tools. Missing capability blocks publishing; do not use private provider endpoints or copied OAuth tokens.",
  privacy:
    "Observe the signed-in account, workspace, edit permission, and current audience before every publication. New Claude artifacts may use documented-private-default evidence. Existing Claude audience needs authenticated-share-inspection. Sites requires authenticated-tool evidence and owner-only access in this release. Public, external, unknown, or unverifiable access is blocked and cannot be approved away. Metadata is attested by the agent, not queried independently by Scope.",
  workflow:
    "Read the snapshot, obtain fresh provider metadata, then prepare with a stable operation UUID, tabId, expectedRevision, provider and observation. A warning persists for the user to acknowledge in Scope. authorize includes the displayed expectedObservation; checkedAt alone may refresh, but changed semantic facts reject stale approval. Export the operation's exact HTML, then start before the first provider mutation. After acknowledgement, refresh the same operation with fresh identical remote facts before start. Changed facts invalidate acknowledgement. A newer local revision needs cancellation and a new preparation. Record progress immediately after a provider returns a destination ID, saved version, or deployment ID. Complete only after confirmed publication. A newer local revision remains pending. Do not modify the exported bytes; adapt the Scope artifact before prepare instead.",
  observation:
    "Use remoteId/url null for a new destination and exact existing values for updates. Account and workspace identities must come from authenticated session evidence. checkedAt is a fresh UTC observation time, not the remote edit date. marker.updatedAt is the provider's publication/edit date or null. marker.version is the exact Claude version, or a verified active Sites marker JSON.stringify({savedVersion, deploymentId}) with exact IDs; when the active production deployment is not exposed, use null instead of inferring it from a saved version. Keep identical marker construction at prepare and completion. Unknown metadata warns. conditionalWrite describes actual provider enforcement. Set it true for Claude only after reading this exact destination and retaining its native base version. Otherwise set false and acknowledge the warning. Always set false for Sites.",
  overwrites:
    "A changed version, later remote edit date, or unknown comparison warns before overwrite. Every existing Sites update also warns because its tools lack conditional version enforcement. Use the Scope dialog to approve that exact observed operation. Recheck immediately before the provider mutation; changed facts require stopping. A Claude 409 stops; never reread and force automatically. Never fall back from Sites private deployment to general deployment.",
  completion:
    "Claude completion requires a confirmed successful native publish result. Sites must retain savedVersion, sourceCommit and deploymentId, then verify terminal success for that exact project and saved version with get_deployment_status. Saved-only, failed, pending, or expected-URL results are insufficient. Write the completion JSON and retry the identical operation/result after an uncertain Scope acknowledgement. No provider result is inferred from a successful Scope command.",
  recovery:
    "One unresolved operation per artifact/provider survives restart. A failed provider response may follow a completed write: reconcile its exact destination, never repeat creation or publishing blindly. Keep the operation until completion or explicit cancellation. A started operation's cancellation or unlink needs acknowledgementUncertain:true after reconciliation. Unlink removes Scope's saved link and checkpoint while leaving remote content intact. No provider credentials belong in commands or HTML.",
  schema: Schema.toJsonSchemaDocument(PublicationsCommand, { onExcessProperty: "error" }).schema,
};

export async function publicationsCommand(
  client: ScopeClient,
  positionals: string[],
  output: string | undefined,
  signal: AbortSignal,
) {
  const [, action, argument, operationId] = positionals;
  if (!argument) throw new Error("Provide an artifact ID or request file. Use publications guide.");
  if (action === "apply") {
    if ((await stat(argument)).size > MAX_PUBLICATIONS_REQUEST_BYTES)
      throw new Error("Publication command exceeds 256 KiB.");
    const bytes = await readFile(argument, { signal });
    if (bytes.byteLength > MAX_PUBLICATIONS_REQUEST_BYTES)
      throw new Error("Publication command exceeds 256 KiB.");
    return client.publications(decode(PublicationsCommand, JSON.parse(bytes.toString("utf8"))));
  }
  const id = decode(ArtifactId, argument);
  if (action === "read") return client.publications({ action, id });
  if (action === "content" && operationId && output) {
    const operation = decode(PublicationTabId, operationId);
    const { snapshot } = await client.publications({ action: "read", id });
    const retained = snapshot.destinations
      .flatMap((destination) => [destination.operation, destination.checkpoint])
      .find((entry) => entry?.operationId === operation);
    if (!retained) throw new Error("This publication operation is no longer retained.");
    const bytes = await client.publicationContent(id, operation);
    if (createHash("sha256").update(bytes).digest("hex") !== retained.blob)
      throw new Error("Scope returned content that differs from the prepared HTML.");
    signal.throwIfAborted();
    await writeFile(output, bytes, { flag: "wx", signal });
    return { id, operationId: operation, revision: retained.revision, blob: retained.blob, output };
  }
  throw new Error(
    "Use publications guide, read ID, apply FILE, or content ID OPERATION --output FILE.",
  );
}
