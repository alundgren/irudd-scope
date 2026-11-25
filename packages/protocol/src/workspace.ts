import * as Schema from "effect/Schema";
import { Artifact, ArtifactName, PublicationTabId, Revision } from "./index.ts";
import {
  WorkspaceAppState,
  WorkspaceNodeAppState,
  WorkspaceNodeId,
  WorkspaceNodeStateObject,
  WorkspaceStateObject,
} from "./workspace-state.ts";

export {
  MAX_WORKSPACE_STATE_BYTES,
  WorkspaceAppState,
  WorkspaceNodeAppState,
  WorkspaceNodeId,
  WorkspaceNodeStateChange,
  WorkspaceNodeStateObject,
  WorkspaceStateChange,
  WorkspaceStateObject,
} from "./workspace-state.ts";

export const MAX_WORKSPACE_REQUEST_BYTES = 256 * 1024;
export const MAX_WORKSPACE_REPLY_BYTES = 32 * 1024 * 1024;
export const MAX_WORKSPACE_DETAIL_IDS = 20;
export const WORKSPACE_CLOSED_RETENTION_DAYS = 30;
export const MAX_WORKSPACE_TRANSITIONS = 500;

const Text = Schema.String.check(Schema.isMaxLength(20_000));
const ShortText = Schema.String.check(Schema.isMaxLength(512));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const WorkspaceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));
export const WorkspaceCommitPair = Schema.Struct({
  headOid: WorkspaceCommit,
  baseOid: WorkspaceCommit,
});
export type WorkspaceCommitPair = typeof WorkspaceCommitPair.Type;

const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);
const Url = Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/), Schema.isMaxLength(2048));

export const WorkspaceRepository = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  name: Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/)),
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;

export const WorkspaceBoardRef = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  ownerType: Schema.Literals(["organization", "user"]),
  number: PositiveInt,
});
export type WorkspaceBoardRef = typeof WorkspaceBoardRef.Type;

export const WorkspaceMilestone = Schema.Struct({
  nodeId: WorkspaceNodeId,
  number: PositiveInt,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  description: Text,
  state: Schema.Literals(["open", "closed"]),
  dueOn: Schema.NullOr(Timestamp),
  updatedAt: Timestamp,
  openIssues: Count,
  closedIssues: Count,
});
export type WorkspaceMilestone = typeof WorkspaceMilestone.Type;

export const WorkspaceIssueType = Schema.Struct({
  id: WorkspaceNodeId,
  name: ShortText,
});

export const WorkspaceIssueFacts = Schema.Struct({
  nodeId: WorkspaceNodeId,
  number: PositiveInt,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.NullOr(
    Schema.Literals(["completed", "not-planned", "reopened", "duplicate"]),
  ),
  author: Schema.NullOr(ShortText),
  assignees: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  labels: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  issueType: Schema.NullOr(WorkspaceIssueType),
  milestoneId: Schema.NullOr(WorkspaceNodeId),
  parentIssueId: Schema.NullOr(WorkspaceNodeId),
  subIssuesSummary: Schema.Struct({
    total: Count,
    completed: Count,
    percentCompleted: Count,
  }),
  dependenciesSummary: Schema.Struct({
    blockedBy: Count,
    blocking: Count,
  }),
  blockedByIds: Schema.Array(WorkspaceNodeId).check(Schema.isMaxLength(200)),
  blockingIds: Schema.Array(WorkspaceNodeId).check(Schema.isMaxLength(200)),
  linkedPrIds: Schema.Array(WorkspaceNodeId).check(Schema.isMaxLength(100)),
  url: Url,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  closedAt: Schema.NullOr(Timestamp),
});
export type WorkspaceIssueFacts = typeof WorkspaceIssueFacts.Type;

export const WorkspaceReviewStatus = Schema.Struct({
  decision: Schema.NullOr(Schema.Literals(["approved", "changes-requested", "review-required"])),
  hasApproval: Schema.NullOr(Schema.Boolean),
  headOid: WorkspaceCommit,
  observedAt: Timestamp,
});

export const WorkspaceMergeQueueEntry = Schema.Struct({
  position: PositiveInt,
  state: Schema.Literals(["queued", "awaiting-checks", "mergeable", "unmergeable", "locked"]),
  enqueuedAt: Timestamp,
  enqueuer: Schema.NullOr(ShortText),
  estimatedSecondsToMerge: Schema.NullOr(Count),
  jump: Schema.Boolean,
  solo: Schema.Boolean,
  headOid: Schema.NullOr(WorkspaceCommit),
  baseOid: Schema.NullOr(WorkspaceCommit),
});

export const WorkspaceMergeQueue = Schema.Struct({
  enabled: Schema.Boolean,
  url: Schema.NullOr(Url),
  size: Schema.NullOr(Count),
  nextEntryEstimatedSecondsToMerge: Schema.NullOr(Count),
  entry: Schema.NullOr(WorkspaceMergeQueueEntry),
  observedAt: Timestamp,
});

export const WorkspacePullRequestFacts = Schema.Struct({
  nodeId: WorkspaceNodeId,
  number: PositiveInt,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  state: Schema.Literals(["open", "closed", "merged"]),
  author: Schema.NullOr(ShortText),
  labels: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  requestedReviewers: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  headOid: Schema.NullOr(WorkspaceCommit),
  headRefName: ShortText,
  baseOid: Schema.NullOr(WorkspaceCommit),
  review: Schema.optionalKey(WorkspaceReviewStatus),
  queue: Schema.optionalKey(WorkspaceMergeQueue),
  draft: Schema.Boolean,
  additions: Revision,
  deletions: Revision,
  changedFiles: Revision,
  milestoneId: Schema.NullOr(WorkspaceNodeId),
  closingIssueIds: Schema.Array(WorkspaceNodeId).check(Schema.isMaxLength(100)),
  merge: Schema.Struct({
    status: Schema.Literals(["unknown", "clear", "conflicting"]),
    headOid: Schema.NullOr(WorkspaceCommit),
    baseOid: Schema.NullOr(WorkspaceCommit),
    observedAt: Timestamp,
  }),
  checks: Schema.Struct({
    status: Schema.Literals(["unknown", "pending", "passing", "failing"]),
    headOid: Schema.NullOr(WorkspaceCommit),
    observedAt: Timestamp,
  }),
  hasUnresolvedConversations: Schema.NullOr(Schema.Boolean),
  url: Url,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  mergedAt: Schema.NullOr(Timestamp),
  closedAt: Schema.NullOr(Timestamp),
});
export type WorkspacePullRequestFacts = typeof WorkspacePullRequestFacts.Type;

export const WorkspaceBoardFieldOption = Schema.Struct({
  id: ShortText,
  name: ShortText,
  color: Schema.NullOr(ShortText),
  description: Schema.NullOr(ShortText),
});

export const WorkspaceBoardIteration = Schema.Struct({
  id: ShortText,
  title: ShortText,
  startDate: ShortText,
  duration: Count,
});

export const WorkspaceBoardField = Schema.Struct({
  id: WorkspaceNodeId,
  name: ShortText,
  dataType: ShortText,
  options: Schema.Array(WorkspaceBoardFieldOption).check(Schema.isMaxLength(200)),
  iterations: Schema.Array(WorkspaceBoardIteration).check(Schema.isMaxLength(200)),
});
export type WorkspaceBoardField = typeof WorkspaceBoardField.Type;

export const WorkspaceBoardView = Schema.Struct({
  id: WorkspaceNodeId,
  number: PositiveInt,
  name: ShortText,
  layout: ShortText,
  filter: Schema.NullOr(Text),
});
export type WorkspaceBoardView = typeof WorkspaceBoardView.Type;

export const WorkspaceBoardFieldValue = Schema.Struct({
  fieldId: WorkspaceNodeId,
  fieldName: ShortText,
  type: Schema.Literals(["single-select", "iteration", "number", "date", "text"]),
  text: Schema.NullOr(Text),
  number: Schema.NullOr(Schema.Finite),
  optionId: Schema.NullOr(ShortText),
  iterationId: Schema.NullOr(ShortText),
  updatedAt: Schema.NullOr(Timestamp),
});
export type WorkspaceBoardFieldValue = typeof WorkspaceBoardFieldValue.Type;

export const WorkspaceBoardItem = Schema.Struct({
  itemId: WorkspaceNodeId,
  position: Count,
  contentType: Schema.Literals(["issue", "pull-request", "draft", "redacted"]),
  contentNodeId: Schema.NullOr(WorkspaceNodeId),
  draftTitle: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  isArchived: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  fieldValues: Schema.Array(WorkspaceBoardFieldValue).check(Schema.isMaxLength(50)),
});
export type WorkspaceBoardItem = typeof WorkspaceBoardItem.Type;

export const WorkspaceBoard = Schema.Struct({
  nodeId: WorkspaceNodeId,
  owner: ShortText,
  ownerType: Schema.Literals(["organization", "user"]),
  number: PositiveInt,
  title: Schema.String.check(Schema.isMaxLength(1024)),
  url: Url,
  updatedAt: Timestamp,
  fields: Schema.Array(WorkspaceBoardField).check(Schema.isMaxLength(100)),
  views: Schema.Array(WorkspaceBoardView).check(Schema.isMaxLength(50)),
  items: Schema.Array(WorkspaceBoardItem).check(Schema.isMaxLength(5000)),
});
export type WorkspaceBoard = typeof WorkspaceBoard.Type;

export const WorkspaceTransition = Schema.Struct({
  id: ShortText,
  at: Timestamp,
  entityType: Schema.Literals(["issue", "pull-request", "board-item", "milestone"]),
  nodeId: WorkspaceNodeId,
  kind: ShortText,
  field: Schema.NullOr(ShortText),
  from: Schema.NullOr(ShortText),
  to: Schema.NullOr(ShortText),
  summary: ShortText,
});
export type WorkspaceTransition = typeof WorkspaceTransition.Type;

export const WorkspaceSnooze = Schema.Struct({
  until: Timestamp,
  wakeOnNewCommit: Schema.Boolean,
  headOid: Schema.NullOr(WorkspaceCommit),
});
export type WorkspaceSnooze = typeof WorkspaceSnooze.Type;

export const WorkspaceBaseline = Schema.Struct({
  headOid: WorkspaceCommit,
  at: Timestamp,
});

export const WorkspaceNodeLocal = Schema.Struct({
  note: Text,
  noteVersion: Revision,
  snooze: Schema.NullOr(WorkspaceSnooze),
  snoozeVersion: Revision,
  inspected: Schema.NullOr(WorkspaceBaseline),
  reviewed: Schema.NullOr(WorkspaceBaseline),
  reviewVersion: Revision,
});
export type WorkspaceNodeLocal = typeof WorkspaceNodeLocal.Type;

export const WorkspaceAssessment = Schema.Struct({
  text: Text,
  author: ShortText,
  headOid: Schema.NullOr(WorkspaceCommit),
  evidenceIds: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
  discussionUpdatedAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
});
export type WorkspaceAssessment = typeof WorkspaceAssessment.Type;

export const WorkspaceCustomField = Schema.Union([
  Schema.Struct({ key: ShortText, type: Schema.Literal("text"), value: Text }),
  Schema.Struct({ key: ShortText, type: Schema.Literal("number"), value: Schema.Finite }),
  Schema.Struct({ key: ShortText, type: Schema.Literal("boolean"), value: Schema.Boolean }),
]);

export const WorkspaceNodeAgent = Schema.Struct({
  version: Revision,
  assessment: Schema.NullOr(WorkspaceAssessment),
  customFields: Schema.Array(WorkspaceCustomField).check(Schema.isMaxLength(50)),
});
export type WorkspaceNodeAgent = typeof WorkspaceNodeAgent.Type;

export const WorkspaceIssue = Schema.Struct({
  ...WorkspaceIssueFacts.fields,
  local: WorkspaceNodeLocal,
  agent: WorkspaceNodeAgent,
});
export type WorkspaceIssue = typeof WorkspaceIssue.Type;

export const WorkspacePullRequest = Schema.Struct({
  ...WorkspacePullRequestFacts.fields,
  local: WorkspaceNodeLocal,
  agent: WorkspaceNodeAgent,
});
export type WorkspacePullRequest = typeof WorkspacePullRequest.Type;

export const WorkspacePullRequestDetail = Schema.Struct({
  headOid: WorkspaceCommit,
  body: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  diff: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
  reviews: Schema.Array(
    Schema.Struct({
      id: ShortText,
      author: Schema.NullOr(ShortText),
      state: ShortText,
      body: Text,
      submittedAt: Schema.NullOr(Timestamp),
      headOid: Schema.NullOr(WorkspaceCommit),
    }),
  ).check(Schema.isMaxLength(10_000)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMaxLength(4096)),
      sha: Schema.optionalKey(Schema.NullOr(WorkspaceCommit)),
      additions: Revision,
      deletions: Revision,
      status: ShortText,
    }),
  ).check(Schema.isMaxLength(10_000)),
  fetchedAt: Timestamp,
});
export type WorkspacePullRequestDetail = typeof WorkspacePullRequestDetail.Type;

export const WorkspacePullRequestDetailResult = Schema.Union([
  Schema.Struct({
    nodeId: WorkspaceNodeId,
    captured: WorkspaceCommitPair,
    detail: WorkspacePullRequestDetail,
  }),
  Schema.Struct({ nodeId: WorkspaceNodeId, error: ShortText }),
]);
export type WorkspacePullRequestDetailResult = typeof WorkspacePullRequestDetailResult.Type;

export const WorkspaceIssueDetail = Schema.Struct({
  nodeId: WorkspaceNodeId,
  body: Schema.String.check(Schema.isMaxLength(256 * 1024)),
  comments: Schema.Array(
    Schema.Struct({
      id: ShortText,
      author: Schema.NullOr(ShortText),
      body: Text,
      createdAt: Timestamp,
    }),
  ).check(Schema.isMaxLength(500)),
  timeline: Schema.Array(
    Schema.Struct({
      type: ShortText,
      at: Timestamp,
      actor: Schema.NullOr(ShortText),
      summary: ShortText,
    }),
  ).check(Schema.isMaxLength(500)),
  fetchedAt: Timestamp,
});
export type WorkspaceIssueDetail = typeof WorkspaceIssueDetail.Type;

export const WorkspaceSyncStatus = Schema.Struct({
  state: Schema.Literals(["idle", "syncing", "error"]),
  updatedAt: Schema.NullOr(Timestamp),
  lastSuccessAt: Schema.NullOr(Timestamp),
  error: Schema.NullOr(ShortText),
  boardError: Schema.optional(Schema.NullOr(ShortText)),
  intervalMs: Schema.optional(Count),
  nextAttemptAt: Schema.optional(Schema.NullOr(Timestamp)),
  reason: Schema.optional(Schema.NullOr(ShortText)),
});
export type WorkspaceSyncStatus = typeof WorkspaceSyncStatus.Type;

export const WorkspaceSnapshot = Schema.Struct({
  artifact: Artifact,
  tabId: PublicationTabId,
  generation: Revision,
  repository: Schema.NullOr(WorkspaceRepository),
  boardRef: Schema.NullOr(WorkspaceBoardRef),
  viewer: Schema.NullOr(ShortText),
  sync: WorkspaceSyncStatus,
  milestones: Schema.Array(WorkspaceMilestone),
  issues: Schema.Array(WorkspaceIssue),
  prs: Schema.Array(WorkspacePullRequest),
  board: Schema.NullOr(WorkspaceBoard),
  transitions: Schema.Array(WorkspaceTransition),
  appState: Schema.optionalKey(WorkspaceAppState),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

const Named = { name: ArtifactName };
const Write = { ...Named, tabId: PublicationTabId, requestId: PublicationTabId };
const Versioned = { ...Write, nodeId: WorkspaceNodeId, expectedVersion: Revision };

export const WorkspaceCommand = Schema.Union([
  Schema.Struct({ ...Named, action: Schema.Literal("read") }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("configure"),
    repository: WorkspaceRepository,
    board: Schema.optionalKey(Schema.NullOr(WorkspaceBoardRef)),
  }),
  Schema.Struct({ ...Write, action: Schema.Literal("sync") }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("pr-detail"),
    nodeId: WorkspaceNodeId,
    captured: Schema.optional(WorkspaceCommitPair),
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("pr-details"),
    nodeIds: Schema.Array(WorkspaceNodeId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_WORKSPACE_DETAIL_IDS),
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("issue-detail"),
    nodeId: WorkspaceNodeId,
  }),
  Schema.Struct({ ...Versioned, action: Schema.Literal("note"), text: Text }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("snooze"),
    snooze: Schema.NullOr(WorkspaceSnooze),
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("review"),
    baseline: Schema.Literals(["inspected", "reviewed"]),
    headOid: WorkspaceCommit,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("assessment"),
    assessment: Schema.NullOr(WorkspaceAssessment),
    customFields: Schema.Array(WorkspaceCustomField).check(Schema.isMaxLength(50)),
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-set"),
    expectedVersion: Revision,
    value: WorkspaceStateObject,
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-patch"),
    expectedVersion: Revision,
    value: WorkspaceStateObject,
  }),
  Schema.Struct({
    ...Write,
    action: Schema.Literal("state-delete"),
    expectedVersion: Revision,
    keys: Schema.Array(Schema.String.check(Schema.isMaxLength(32 * 1024))).check(
      Schema.isMaxLength(1000),
    ),
  }),
  Schema.Struct({
    ...Named,
    tabId: PublicationTabId,
    nodeId: WorkspaceNodeId,
    action: Schema.Literal("node-state-read"),
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("node-state-set"),
    value: WorkspaceNodeStateObject,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("node-state-patch"),
    value: WorkspaceNodeStateObject,
  }),
  Schema.Struct({
    ...Versioned,
    action: Schema.Literal("node-state-delete"),
    keys: Schema.Array(Schema.String).check(Schema.isMaxLength(1000)),
  }),
]);
export type WorkspaceCommand = typeof WorkspaceCommand.Type;

export const WorkspaceReply = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: WorkspaceSnapshot }),
  Schema.Struct({
    type: Schema.Literal("pr-detail"),
    tabId: PublicationTabId,
    nodeId: WorkspaceNodeId,
    detail: WorkspacePullRequestDetail,
  }),
  Schema.Struct({
    type: Schema.Literal("pr-details"),
    tabId: PublicationTabId,
    results: Schema.Array(WorkspacePullRequestDetailResult).check(
      Schema.isMaxLength(MAX_WORKSPACE_DETAIL_IDS),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("issue-detail"),
    tabId: PublicationTabId,
    nodeId: WorkspaceNodeId,
    detail: WorkspaceIssueDetail,
  }),
  Schema.Struct({
    type: Schema.Literal("node-state"),
    tabId: PublicationTabId,
    nodeId: WorkspaceNodeId,
    state: WorkspaceNodeAppState,
  }),
]);
export type WorkspaceReply = typeof WorkspaceReply.Type;
export { WorkspaceEvent } from "./index.ts";
