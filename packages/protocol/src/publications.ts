import * as Schema from "effect/Schema";
import { Artifact, ArtifactId, BlobId, PublicationTabId, Revision } from "./index.ts";

export const MAX_PUBLICATIONS_REQUEST_BYTES = 256 * 1024;
export const MAX_PUBLICATIONS_REPLY_BYTES = 1024 * 1024;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
);
const Url = Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\/[^\s]+$/));
export const PublicationProvider = Schema.Literals(["claude", "sites"]);
export type PublicationProvider = typeof PublicationProvider.Type;
export const PublicationMarker = Schema.Struct({
  version: Schema.NullOr(Text),
  updatedAt: Schema.NullOr(Timestamp),
});
export type PublicationMarker = typeof PublicationMarker.Type;
export const PublicationObservation = Schema.Struct({
  accountId: Text,
  workspaceId: Schema.NullOr(Text),
  remoteId: Schema.NullOr(Text),
  url: Schema.NullOr(Url),
  access: Schema.Literals(["owner", "editor", "none", "unknown"]),
  audience: Schema.Literals(["owner", "team", "public", "external", "unknown"]),
  evidence: Schema.Literals([
    "authenticated-tool",
    "authenticated-share-inspection",
    "documented-private-default",
  ]),
  checkedAt: Timestamp,
  marker: PublicationMarker,
  conditionalWrite: Schema.Boolean,
});
export type PublicationObservation = typeof PublicationObservation.Type;
export const PublicationProgress = Schema.Struct({
  remoteId: Text,
  url: Url,
  savedVersion: Schema.NullOr(Text),
  sourceCommit: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/))),
  deploymentId: Schema.NullOr(Text),
});
export type PublicationProgress = typeof PublicationProgress.Type;
export const PublicationSuccess = Schema.Struct({
  ...PublicationProgress.fields,
  provider: PublicationProvider,
  marker: PublicationMarker,
  confirmedAt: Timestamp,
  state: Schema.Literal("succeeded"),
});
export type PublicationSuccess = typeof PublicationSuccess.Type;
export const PublicationOperation = Schema.Struct({
  operationId: PublicationTabId,
  provider: PublicationProvider,
  revision: Revision,
  blob: BlobId,
  observation: PublicationObservation,
  state: Schema.Literals(["blocked", "warning", "prepared", "started"]),
  warnings: Schema.Array(Text),
  createdAt: Timestamp,
  progress: Schema.NullOr(PublicationProgress),
});
export type PublicationOperation = typeof PublicationOperation.Type;
export const PublicationCheckpoint = Schema.Struct({
  operationId: PublicationTabId,
  revision: Revision,
  blob: BlobId,
  observation: PublicationObservation,
  result: PublicationSuccess,
});
export type PublicationCheckpoint = typeof PublicationCheckpoint.Type;
export const PublicationDestination = Schema.Struct({
  provider: PublicationProvider,
  checkpoint: Schema.NullOr(PublicationCheckpoint),
  operation: Schema.NullOr(PublicationOperation),
});
export type PublicationDestination = typeof PublicationDestination.Type;
export const PublicationsSnapshot = Schema.Struct({
  artifact: Artifact,
  tabId: PublicationTabId,
  destinations: Schema.Array(PublicationDestination),
});
export type PublicationsSnapshot = typeof PublicationsSnapshot.Type;
const Address = { id: ArtifactId };
const Operation = {
  ...Address,
  tabId: PublicationTabId,
  provider: PublicationProvider,
  operationId: PublicationTabId,
};
export const PublicationsCommand = Schema.Union([
  Schema.Struct({ ...Address, action: Schema.Literal("read") }),
  Schema.Struct({
    ...Operation,
    action: Schema.Literal("prepare"),
    expectedRevision: Revision,
    observation: PublicationObservation,
  }),
  Schema.Struct({
    ...Operation,
    action: Schema.Literal("refresh"),
    observation: PublicationObservation,
  }),
  Schema.Struct({ ...Operation, action: Schema.Literal("authorize") }),
  Schema.Struct({ ...Operation, action: Schema.Literal("start") }),
  Schema.Struct({
    ...Operation,
    action: Schema.Literal("progress"),
    progress: PublicationProgress,
  }),
  Schema.Struct({ ...Operation, action: Schema.Literal("complete"), result: PublicationSuccess }),
  Schema.Struct({
    ...Operation,
    action: Schema.Literal("cancel"),
    acknowledgeUncertain: Schema.Boolean,
  }),
  Schema.Struct({
    ...Address,
    tabId: PublicationTabId,
    provider: PublicationProvider,
    action: Schema.Literal("unlink"),
    acknowledgeUncertain: Schema.Boolean,
  }),
]);
export type PublicationsCommand = typeof PublicationsCommand.Type;
export const PublicationsReply = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: PublicationsSnapshot,
  decision: Schema.Literals(["allowed", "warning", "blocked"]),
  messages: Schema.Array(Text),
});
export type PublicationsReply = typeof PublicationsReply.Type;
export { PublicationsEvent } from "./index.ts";
