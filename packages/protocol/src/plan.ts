import { Schema } from "effect";
import { Artifact, ArtifactName, BlobId, PublicationTabId, Revision } from "./index.ts";

export const MAX_PLAN_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PLAN_REQUEST_BYTES = 48 * 1024 * 1024;
export const MAX_PLAN_REPLY_BYTES = 16 * 1024 * 1024;
export const PLAN_READ_CONFLICT = "Plan changed during read. Refresh and try again.";
export const PlanCursor = Schema.Struct({
  version: Revision,
  afterRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  afterRecord: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PlanCursor = typeof PlanCursor.Type;
export const PlanRecordId = PublicationTabId;
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const Label = Schema.String.check(Schema.isMaxLength(512));
const Coordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const PlanPoint = Schema.Struct({ x: Coordinate, y: Coordinate });
export const PlanAnnotation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("arrow"), from: PlanPoint, to: PlanPoint }),
  Schema.Struct({ type: Schema.Literal("box"), from: PlanPoint, to: PlanPoint }),
  Schema.Struct({ type: Schema.Literal("pin"), at: PlanPoint }),
]);
export type PlanAnnotation = typeof PlanAnnotation.Type;
export const PlanAnnotations = Schema.Array(PlanAnnotation).check(Schema.isMaxLength(50));
export const PlanImage = Schema.Struct({
  id: BlobId,
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
});
export type PlanImage = typeof PlanImage.Type;
export const PlanViewport = Schema.Struct({
  scrollX: Schema.Number.check(Schema.isFinite()),
  scrollY: Schema.Number.check(Schema.isFinite()),
  width: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  height: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
});
export type PlanViewport = typeof PlanViewport.Type;
export const PlanComment = Schema.Struct({
  id: PlanRecordId,
  revision: Revision,
  page: Label,
  text: Text,
  image: PlanImage,
  originalImage: PlanImage,
  annotations: PlanAnnotations,
  viewport: Schema.optionalKey(PlanViewport),
  selectedText: Schema.optionalKey(Label),
  elementId: Schema.optionalKey(Label),
  createdAt: Schema.String,
  resolved: Schema.Boolean,
});
export type PlanComment = typeof PlanComment.Type;
export const PlanRound = Schema.Struct({
  id: PlanRecordId,
  revision: Revision,
  commentIds: Schema.Array(PlanRecordId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  message: Schema.optionalKey(Text),
  createdAt: Schema.String,
  status: Schema.Literals(["pending", "responded"]),
});
export type PlanRound = typeof PlanRound.Type;
export const PlanThreadReply = Schema.Struct({ commentId: PlanRecordId, text: Text });
export const PlanResponse = Schema.Struct({
  id: PlanRecordId,
  roundId: PlanRecordId,
  baseRevision: Revision,
  revision: Revision,
  summary: Text,
  replies: Schema.Array(PlanThreadReply).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  createdAt: Schema.String,
  seen: Schema.Boolean,
});
export type PlanResponse = typeof PlanResponse.Type;
export const PlanRevision = Schema.Struct({
  revision: Revision,
  title: Schema.String,
  createdAt: Schema.String,
  approvedAt: Schema.NullOr(Schema.String),
});
export type PlanRevision = typeof PlanRevision.Type;
export const PlanSnapshot = Schema.Struct({
  artifact: Artifact,
  version: Revision,
  revisions: Schema.Array(PlanRevision),
  comments: Schema.Array(PlanComment),
  rounds: Schema.Array(PlanRound),
  responses: Schema.Array(PlanResponse),
});
export type PlanSnapshot = typeof PlanSnapshot.Type;
const Named = { name: ArtifactName };
const Write = { ...Named, requestId: PlanRecordId };
export const PlanCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("read"),
    ...Named,
    since: Schema.optionalKey(Revision),
    cursor: Schema.optionalKey(PlanCursor),
    roundId: Schema.optionalKey(PlanRecordId),
    pending: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("comment"),
    ...Write,
    revision: Revision,
    page: Label,
    text: Text,
    image: Schema.String.check(Schema.isMaxLength(Math.ceil(MAX_PLAN_IMAGE_BYTES / 3) * 4)),
    annotatedImage: Schema.String.check(
      Schema.isMaxLength(Math.ceil(MAX_PLAN_IMAGE_BYTES / 3) * 4),
    ),
    annotations: PlanAnnotations,
    viewport: Schema.optionalKey(PlanViewport),
    selectedText: Schema.optionalKey(Label),
    elementId: Schema.optionalKey(Label),
  }),
  Schema.Struct({
    action: Schema.Literal("submit"),
    ...Write,
    commentIds: Schema.Array(PlanRecordId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    message: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    action: Schema.Literal("respond"),
    ...Write,
    roundId: PlanRecordId,
    expectedRevision: Revision,
    summary: Text,
    replies: Schema.Array(PlanThreadReply).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    html: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024))),
  }),
  Schema.Struct({
    action: Schema.Literal("delete-comment"),
    ...Write,
    commentId: PlanRecordId,
  }),
  Schema.Struct({
    action: Schema.Literal("resolve"),
    ...Write,
    commentId: PlanRecordId,
    resolved: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("seen"),
    ...Write,
    responseId: PlanRecordId,
    seen: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("approve"), ...Write, expectedRevision: Revision }),
  Schema.Struct({
    action: Schema.Literal("restore"),
    ...Write,
    revision: Revision,
    expectedRevision: Revision,
  }),
]);
export type PlanCommand = typeof PlanCommand.Type;
export const PlanReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    snapshot: PlanSnapshot,
    next: Schema.optionalKey(PlanCursor),
  }),
  Schema.Struct({ type: Schema.Literal("unchanged"), version: Revision }),
  Schema.Struct({
    type: Schema.Literal("receipt"),
    artifact: Artifact,
    version: Revision,
    recordId: Schema.optionalKey(PlanRecordId),
  }),
]);
export type PlanReply = typeof PlanReply.Type;
export { PlanEvent } from "./index.ts";

export async function readPlanSnapshot(
  send: (command: PlanCommand) => Promise<PlanReply>,
  name: string,
  options: { roundId?: string; pending?: boolean } = {},
): Promise<PlanSnapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      let reply = await send({ action: "read", name, ...options });
      if (reply.type !== "snapshot") throw new Error("Expected a plan history page.");
      const snapshot = reply.snapshot;
      const revisions = [...snapshot.revisions],
        comments = [...snapshot.comments],
        rounds = [...snapshot.rounds],
        responses = [...snapshot.responses];
      while (reply.next) {
        const cursor = reply.next;
        reply = await send({ action: "read", name, ...options, cursor });
        if (reply.type !== "snapshot") throw new Error("Expected a plan history page.");
        if (reply.snapshot.version !== snapshot.version) throw new Error(PLAN_READ_CONFLICT);
        if (
          reply.next &&
          reply.next.afterRecord <= cursor.afterRecord &&
          reply.next.afterRevision <= cursor.afterRevision
        )
          throw new Error("Plan history cursor did not advance.");
        revisions.push(...reply.snapshot.revisions);
        comments.push(...reply.snapshot.comments);
        rounds.push(...reply.snapshot.rounds);
        responses.push(...reply.snapshot.responses);
      }
      return { ...snapshot, revisions, comments, rounds, responses };
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !error.message.includes(PLAN_READ_CONFLICT))
        throw error;
    }
  }
}
