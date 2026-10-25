import { Schema } from "effect";
import {
  Artifact,
  ArtifactId,
  MAX_CONTENT_BYTES,
  MAX_METADATA_BYTES,
  PublicationTabId,
  Revision,
} from "./index.ts";
import { GuestId } from "./guest.ts";
import { GuestSource } from "./guest.ts";
import { PlanDocument } from "./plan.ts";

export const GUEST_OPERATION_CAPABILITY = "mutations-v1";
export const GUEST_OPERATION_RETENTION_MS = 48 * 60 * 60_000;
export const MAX_GUEST_OPERATIONS = 4096;
export const MAX_GUEST_OPERATION_BYTES = 34 * 1024 * 1024;
export const GuestTarget = Schema.Struct({
  ownerDeviceId: GuestId,
  sourceTabId: PublicationTabId,
});
export type GuestTarget = typeof GuestTarget.Type;
export const GuestAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rename"),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  }),
  Schema.Struct({ kind: Schema.Literal("retention"), permanent: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("trash") }),
  Schema.Struct({ kind: Schema.Literal("replace-plan"), document: PlanDocument }),
  Schema.Struct({
    kind: Schema.Literal("capture-basis"),
    basisId: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)),
  }),
]);
export type GuestAction = typeof GuestAction.Type;
export const GuestChange = Schema.Struct({
  version: Schema.Literal(1),
  target: GuestTarget,
  expectedSourceVersion: Revision,
  expectedRevision: Revision,
  action: GuestAction,
});
export type GuestChange = typeof GuestChange.Type;
export const GuestOperationIdentity = Schema.Struct({
  operationId: GuestId,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type GuestOperationIdentity = typeof GuestOperationIdentity.Type;
export const GuestOperation = Schema.Struct({
  ...GuestOperationIdentity.fields,
  change: GuestChange,
});
export type GuestOperation = typeof GuestOperation.Type;
export const GuestOutcome = Schema.Struct({
  ...GuestOperationIdentity.fields,
  state: Schema.Literals(["prepared", "completed", "conflict", "rejected", "unknown", "expired"]),
  expiresAt: Schema.Int,
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  sourceVersion: Schema.optionalKey(Revision),
  artifact: Schema.optionalKey(Artifact),
});
export type GuestOutcome = typeof GuestOutcome.Type;
export const GuestRead = Schema.Struct({ target: GuestTarget, revision: Revision });
export type GuestRead = typeof GuestRead.Type;

/** JSON escaping of the original UTF-8 content can double a valid plan's bytes. */
export const MAX_GUEST_READ_BYTES = 2 * MAX_CONTENT_BYTES + MAX_METADATA_BYTES;
export const GUEST_PLANS_CAPABILITY = "guest-plans-v1";
export const GUEST_COMMAND_TIMEOUT_MS = 120_000;
export const GuestCapabilities = Schema.Struct({ capabilities: Schema.Array(Schema.String) });
export const GuestReadReply = Schema.Struct({ artifact: Artifact, content: Schema.String });
export const GuestPendingReply = Schema.Struct({
  artifactId: Schema.optionalKey(ArtifactId),
  operation: GuestOperation,
  outcome: GuestOutcome,
  dispatched: Schema.Boolean,
});
export const GuestReconciled = Schema.Struct({
  outcome: GuestOutcome,
  source: Schema.NullOr(GuestSource),
});
export function guestCommandRequest(method: string, path: string): boolean {
  return (
    (method === "GET" && path === "/v1/guests/capabilities") ||
    (method === "POST" &&
      /^\/v1\/guests\/(source|read|pending|prepare|execute|status|reconcile)$/.test(path))
  );
}
