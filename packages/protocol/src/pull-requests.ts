import * as Schema from "effect/Schema";
import { Artifact, ArtifactName, PublicationTabId, Revision } from "./index.ts";
import {
  PullRequestsAppState,
  PullRequestsStateObject,
  PullRequestAppState,
  PullRequestStateObject,
  PullRequestNodeId,
} from "./pull-requests-state.ts";
export {
  PullRequestAppState,
  PullRequestStateObject,
  PullRequestStateChange,
  PullRequestNodeId,
  PullRequestsAppState,
  PullRequestsStateObject,
  PullRequestsStateChange,
  MAX_PULL_REQUESTS_STATE_BYTES,
} from "./pull-requests-state.ts";

export const MAX_PULL_REQUESTS_REQUEST_BYTES = 256 * 1024;
export const MAX_PULL_REQUESTS_REPLY_BYTES = 32 * 1024 * 1024;
export const MAX_PULL_REQUESTS_DETAIL_IDS = 20;
const Text = Schema.String.check(Schema.isMaxLength(20_000));
const ShortText = Schema.String.check(Schema.isMaxLength(512));
export const PullRequestCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
export const PullRequestCommitPair = Schema.Struct({
  headOid: PullRequestCommit,
  baseOid: PullRequestCommit,
});
export type PullRequestCommitPair = typeof PullRequestCommitPair.Type;
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);
export const PullRequestsRepository = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  name: Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/)),
});
export type PullRequestsRepository = typeof PullRequestsRepository.Type;
export const PullRequestReviewStatus = Schema.Struct({
  decision: Schema.NullOr(Schema.Literals(["approved", "changes-requested", "review-required"])),
  hasApproval: Schema.NullOr(Schema.Boolean),
  headOid: PullRequestCommit,
  observedAt: Timestamp,
});
export const PullRequestStackMember = Schema.Struct({
  nodeId: PullRequestNodeId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
});
export const PullRequestStack = Schema.Struct({
  nodeId: PullRequestNodeId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  baseRefName: ShortText,
  members: Schema.Array(PullRequestStackMember),
  readyForReview: Schema.Boolean,
  approved: Schema.NullOr(Schema.Boolean),
  observedAt: Timestamp,
});
export type PullRequestStack = typeof PullRequestStack.Type;
export const PullRequestFacts = Schema.Struct({
  nodeId: PullRequestNodeId,
  number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  author: Schema.NullOr(ShortText),
  labels: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  headOid: PullRequestCommit,
  headRefName: ShortText,
  baseOid: PullRequestCommit,
  review: Schema.optionalKey(PullRequestReviewStatus),
  stack: Schema.optionalKey(Schema.NullOr(PullRequestStack)),
  draft: Schema.Boolean,
  additions: Revision,
  deletions: Revision,
  changedFiles: Revision,
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/),
    Schema.isMaxLength(2048),
  ),
  merge: Schema.Struct({
    status: Schema.Literals(["unknown", "clear", "conflicting"]),
    headOid: PullRequestCommit,
    baseOid: PullRequestCommit,
    observedAt: Timestamp,
  }),
  checks: Schema.Struct({
    status: Schema.Literals(["unknown", "pending", "passing", "failing"]),
    headOid: Schema.NullOr(PullRequestCommit),
    observedAt: Timestamp,
  }),
  hasUnresolvedConversations: Schema.NullOr(Schema.Boolean),
  createdAt: Timestamp,
  requestedReviewers: Schema.Array(ShortText),
  updatedAt: Timestamp,
});
export type PullRequestFacts = typeof PullRequestFacts.Type;
export const PullRequestDetail = Schema.Struct({
  headOid: PullRequestCommit,
  body: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  diff: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
  reviews: Schema.Array(
    Schema.Struct({
      id: ShortText,
      author: Schema.NullOr(ShortText),
      state: ShortText,
      body: Text,
      submittedAt: Schema.NullOr(Timestamp),
      headOid: Schema.NullOr(PullRequestCommit),
    }),
  ).check(Schema.isMaxLength(10_000)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMaxLength(4096)),
      sha: Schema.optionalKey(Schema.NullOr(PullRequestCommit)),
      additions: Revision,
      deletions: Revision,
      status: ShortText,
    }),
  ).check(Schema.isMaxLength(10_000)),
  fetchedAt: Timestamp,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;
export const PullRequestDetailResult = Schema.Union([
  Schema.Struct({
    nodeId: PullRequestNodeId,
    captured: PullRequestCommitPair,
    detail: PullRequestDetail,
  }),
  Schema.Struct({ nodeId: PullRequestNodeId, error: ShortText }),
]);
export type PullRequestDetailResult = typeof PullRequestDetailResult.Type;
export const PullRequestSnooze = Schema.Struct({
  until: Timestamp,
  wakeOnNewCommit: Schema.Boolean,
  headOid: PullRequestCommit,
});
export type PullRequestSnooze = typeof PullRequestSnooze.Type;
export const PullRequestBaseline = Schema.Struct({ headOid: PullRequestCommit, at: Timestamp });
export const PullRequestLocal = Schema.Struct({
  note: Text,
  noteVersion: Revision,
  snooze: Schema.NullOr(PullRequestSnooze),
  snoozeVersion: Revision,
  inspected: Schema.NullOr(PullRequestBaseline),
  reviewed: Schema.NullOr(PullRequestBaseline),
  reviewVersion: Revision,
});
export type PullRequestLocal = typeof PullRequestLocal.Type;
export const PullRequestAssessment = Schema.Struct({
  text: Text,
  author: ShortText,
  headOid: PullRequestCommit,
  evidenceIds: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  discussionUpdatedAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
});
export type PullRequestAssessment = typeof PullRequestAssessment.Type;
export const PullRequestCustomField = Schema.Union([
  Schema.Struct({ key: ShortText, type: Schema.Literal("text"), value: Text }),
  Schema.Struct({ key: ShortText, type: Schema.Literal("number"), value: Schema.Finite }),
  Schema.Struct({ key: ShortText, type: Schema.Literal("boolean"), value: Schema.Boolean }),
]);
export const PullRequestAgent = Schema.Struct({
  version: Revision,
  assessment: Schema.NullOr(PullRequestAssessment),
  customFields: Schema.Array(PullRequestCustomField).check(Schema.isMaxLength(50)),
});
export type PullRequestAgent = typeof PullRequestAgent.Type;
export const PullRequest = Schema.Struct({
  ...PullRequestFacts.fields,
  local: PullRequestLocal,
  agent: PullRequestAgent,
});
export type PullRequest = typeof PullRequest.Type;
export const PullRequestsSync = Schema.Struct({
  state: Schema.Literals(["idle", "syncing", "error"]),
  updatedAt: Schema.NullOr(Timestamp),
  lastSuccessAt: Schema.NullOr(Timestamp),
  error: Schema.NullOr(ShortText),
  intervalMs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nextAttemptAt: Schema.optional(Schema.NullOr(Timestamp)),
  reason: Schema.optional(Schema.NullOr(ShortText)),
});
export type PullRequestsSync = typeof PullRequestsSync.Type;
export const PullRequestsSnapshot = Schema.Struct({
  artifact: Artifact,
  tabId: PublicationTabId,
  generation: Revision,
  repository: Schema.NullOr(PullRequestsRepository),
  viewer: Schema.NullOr(ShortText),
  sync: PullRequestsSync,
  prs: Schema.Array(PullRequest),
  appState: Schema.optionalKey(PullRequestsAppState),
});
export type PullRequestsSnapshot = typeof PullRequestsSnapshot.Type;
const Named = { name: ArtifactName };
const Write = { ...Named, tabId: PublicationTabId, requestId: PublicationTabId };
const Versioned = { ...Write, nodeId: PullRequestNodeId, expectedVersion: Revision };
export const PullRequestsCommand = Schema.Union([
  Schema.Struct({
    ...Named,
    tabId: PublicationTabId,
    nodeId: PullRequestNodeId,
    action: Schema.Literal("pr-state-read"),
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("pr-state-set"),
    value: PullRequestStateObject,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("pr-state-patch"),
    value: PullRequestStateObject,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("pr-state-delete"),
    keys: Schema.Array(Schema.String).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-set"),
    expectedVersion: Revision,
    value: PullRequestsStateObject,
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-patch"),
    expectedVersion: Revision,
    value: PullRequestsStateObject,
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-delete"),
    expectedVersion: Revision,
    keys: Schema.Array(Schema.String.check(Schema.isMaxLength(32 * 1024))).check(
      Schema.isMaxLength(1000),
    ),
  }),
  Schema.Struct({ ...Named, action: Schema.Literal("read") }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("configure"),
    repository: PullRequestsRepository,
  }),
  Schema.Struct({ ...Write, action: Schema.Literal("sync") }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("detail"),
    nodeId: PullRequestNodeId,
    captured: Schema.optional(PullRequestCommitPair),
  }),
  Schema.Struct({ ...Versioned, action: Schema.Literal("note"), text: Text }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("details"),
    nodeIds: Schema.Array(PullRequestNodeId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_PULL_REQUESTS_DETAIL_IDS),
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("snooze"),
    snooze: Schema.NullOr(PullRequestSnooze),
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("review"),
    baseline: Schema.Literals(["inspected", "reviewed"]),
    headOid: PullRequestCommit,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("assessment"),
    assessment: Schema.NullOr(PullRequestAssessment),
    customFields: Schema.Array(PullRequestCustomField).check(Schema.isMaxLength(50)),
  }),
]);
export type PullRequestsCommand = typeof PullRequestsCommand.Type;
export const PullRequestsReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pr-state"),
    tabId: PublicationTabId,
    nodeId: PullRequestNodeId,
    state: PullRequestAppState,
  }),
  Schema.Struct({
    type: Schema.Literal("details"),
    tabId: PublicationTabId,
    results: Schema.Array(PullRequestDetailResult).check(
      Schema.isMaxLength(MAX_PULL_REQUESTS_DETAIL_IDS),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: PullRequestsSnapshot }),
  Schema.Struct({
    type: Schema.Literal("detail"),
    tabId: PublicationTabId,
    nodeId: PullRequestNodeId,
    detail: PullRequestDetail,
  }),
]);
export type PullRequestsReply = typeof PullRequestsReply.Type;
export { PullRequestsEvent } from "./index.ts";
