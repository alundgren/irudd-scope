import { Schema } from "effect";

const Text = Schema.String.check(Schema.isMaxLength(1_000_000));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const LibrarianPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("-") &&
      !/[\\\x00-\x1f]/.test(p) &&
      p.split("/").every((v) => !!v && v !== "." && v !== ".."),
    { expected: "a relative bundle path" },
  ),
);
export const MemoryActor = Schema.Struct({ type: Schema.Literals(["agent", "human"]), id: Name });
export const MemoryApplicability = Schema.Union([
  Schema.Struct({ type: Schema.Literal("global") }),
  Schema.Struct({ type: Schema.Literals(["machine", "repository"]), id: Name }),
]);
export const MemorySource = Schema.Struct({
  path: LibrarianPath,
  hash: Hash,
  bundle: Schema.optionalKey(Name),
  id: Schema.optionalKey(Name),
  displayTitle: Schema.optionalKey(Text),
  applicability: Schema.optionalKey(MemoryApplicability),
});
const Snapshot = Schema.Struct({ raw: Text, hash: Hash });
const MemoryReview = Schema.Struct({
  actor: MemoryActor,
  reason: Text,
  at: Name,
  decision: Schema.Literals(["accept", "reject"]),
  revisionHash: Hash,
  sources: Schema.Array(MemorySource),
});
export const MemoryChange = Schema.Struct({
  version: Schema.Literal(1),
  id: Name,
  bundle: Name,
  path: LibrarianPath,
  action: Schema.Literals(["create", "update", "delete"]),
  before: Schema.NullOr(Snapshot),
  after: Schema.NullOr(Snapshot),
  revisionHash: Hash,
  status: Schema.Literals(["pending", "accepted", "rejected", "superseded"]),
  actor: MemoryActor,
  reason: Text,
  createdAt: Name,
  sources: Schema.Array(MemorySource),
  humanRequired: Schema.optionalKey(Schema.Boolean),
  requestId: Schema.optionalKey(Name),
  replacementChangeId: Schema.optionalKey(Name),
  agentReview: Schema.optionalKey(MemoryReview),
  humanReview: Schema.optionalKey(MemoryReview),
  display: Schema.optionalKey(
    Schema.Struct({
      title: Text,
      beforeBody: Schema.NullOr(Text),
      afterBody: Schema.NullOr(Text),
      beforeMemory: Schema.optionalKey(Schema.Unknown),
      afterMemory: Schema.optionalKey(Schema.Unknown),
    }),
  ),
  reviews: Schema.optionalKey(Schema.Array(MemoryReview)),
  review: Schema.optionalKey(MemoryReview),
});
export type MemoryChange = typeof MemoryChange.Type;
export const LibrarianProposal = Schema.Struct({
  change: MemoryChange,
  disposition: Schema.Literals(["human", "automatic"]),
  permission: Schema.optionalKey(Name),
  evidence: Text,
});
export type LibrarianProposal = typeof LibrarianProposal.Type;
export const LibrarianRun = Schema.Struct({
  id: Name,
  sessionId: Name,
  userRequest: Text,
  startedAt: Name,
  bundle: Schema.Struct({ id: Name, root: Text, formatVersion: Schema.Literal(2) }),
  status: Schema.Literals(["active", "interrupted", "completed"]),
  automaticPermissions: Schema.Array(Name).check(Schema.isMaxLength(30)),
  proposals: Schema.Array(LibrarianProposal).check(Schema.isMaxLength(1000)),
  completedAt: Schema.optionalKey(Name),
  finishRequest: Schema.optionalKey(Text),
  activity: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        action: Schema.Literals(["start", "resume", "interrupt", "finish"]),
        sessionId: Name,
        userRequest: Text,
        at: Name,
      }),
    ),
  ),
});
export type LibrarianRun = typeof LibrarianRun.Type;
const Views = [
  "browse",
  "memory",
  "decision",
  "overview",
  "recovery",
  "connections",
  "stages",
  "activity",
  "machines",
] as const;
const Value = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const LibrarianStage = Schema.Literals(["bronze", "silver", "gold", "none"]);
export const LibrarianFilters = Schema.Struct({
  tag: Schema.optionalKey(Value),
  stage: Schema.optionalKey(LibrarianStage),
  kind: Schema.optionalKey(Value),
  applicability: Schema.optionalKey(Schema.Literals(["global", "machine", "repository"])),
});
export type LibrarianFilters = typeof LibrarianFilters.Type;
const Trail = Schema.Array(LibrarianPath).check(Schema.isMaxLength(20));
const Section = Schema.Literals(["connections", "changes"]);
export const LibrarianConnections = Schema.Struct({
  depth: Schema.Literals([1, 2]),
  sharedTags: Schema.Boolean,
});
export const LibrarianStages = Schema.Struct({
  stage: Schema.optionalKey(LibrarianStage),
  offset: Revision,
});
export const LibrarianActivity = Schema.Struct({
  offset: Revision,
  status: Schema.optionalKey(Schema.Literals(["pending", "accepted", "rejected", "superseded"])),
  onlySelected: Schema.Boolean,
  changeId: Schema.optionalKey(Name),
  sourceHash: Schema.optionalKey(Hash),
});
export type LibrarianActivity = typeof LibrarianActivity.Type;
export const LibrarianView = Schema.Struct({
  version: Schema.Literal(1),
  uiRevision: Revision,
  view: Schema.Literals(Views),
  query: Text,
  directory: Schema.String,
  offset: Revision,
  displayed: Schema.Unknown,
  bundle: Schema.optionalKey(LibrarianRun.fields.bundle),
  comparisonOpen: Schema.optionalKey(Schema.Boolean),
  evidenceOpen: Schema.optionalKey(Schema.Boolean),
  selectedPath: Schema.optionalKey(LibrarianPath),
  selectedChangeId: Schema.optionalKey(Name),
  run: Schema.optionalKey(LibrarianRun),
  history: Schema.Array(LibrarianRun),
  historyRunId: Schema.optionalKey(Name),
  pendingCount: Schema.optionalKey(Revision),
  completedCount: Schema.optionalKey(Revision),
  overview: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Name,
        path: LibrarianPath,
        title: Schema.optionalKey(Text),
        status: Schema.String,
        actor: Schema.String,
      }),
    ).check(Schema.isMaxLength(10)),
  ),
  reminder: Schema.Struct({
    enabled: Schema.Boolean,
    dueAt: Name,
    dismissedAt: Schema.optionalKey(Name),
  }),
  /** The memory shared by the reader, Connections, Stages and Activity. */
  focusPath: Schema.optionalKey(LibrarianPath),
  browse: Schema.optionalKey(
    Schema.Struct({
      filters: LibrarianFilters,
      trail: Trail,
      section: Schema.optionalKey(Section),
      /** Browse's own page, since the completed overview reuses the top-level offset. */
      offset: Schema.optionalKey(Revision),
      /** Whether Browse last showed the reader rather than the result list. */
      reading: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** The result page shown beside the reader. */
  results: Schema.optionalKey(Schema.Unknown),
  facets: Schema.optionalKey(Schema.Unknown),
  connections: Schema.optionalKey(LibrarianConnections),
  stages: Schema.optionalKey(LibrarianStages),
  activity: Schema.optionalKey(LibrarianActivity),
  returnChangeId: Schema.optionalKey(Name),
});
export type LibrarianView = typeof LibrarianView.Type;
/**
 * Clients check only the reply envelope so a newer desktop's views and fields reach them unchanged.
 */
export const LibrarianReplyEnvelope = Schema.Struct({
  state: Schema.Struct({ version: Schema.Literal(1), uiRevision: Revision, view: Schema.String }),
  capability: Schema.optionalKey(Name),
});
/** Routine categories a dreaming run may handle without a human unless the person narrows them. */
export const LibrarianRoutineWork = [
  "merge-duplicates",
  "consolidate-episodes",
  "add-evidence",
  "promote-stage",
  "archive-stale",
  "repair-links",
] as const;
const Permissions = Schema.Array(Name).check(Schema.isMaxLength(30));
const Operation = { requestId: Name, expectedUiRevision: Revision };
const Connection = { runId: Name, capability: Name, sessionId: Name };
export const LibrarianCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read") }),
  Schema.Struct({ action: Schema.Literal("local"), root: Text, initialize: Schema.Boolean }),
  Schema.Struct({
    action: Schema.Literal("start"),
    ...Operation,
    sessionId: Name,
    userRequest: Text,
    automaticPermissions: Schema.optionalKey(Permissions),
  }),
  Schema.Struct({
    action: Schema.Literal("resume"),
    ...Operation,
    runId: Name,
    sessionId: Name,
    userRequest: Text,
    automaticPermissions: Schema.optionalKey(Permissions),
  }),
  Schema.Struct({
    action: Schema.Literal("present"),
    ...Operation,
    ...Connection,
    changeId: Name,
    disposition: Schema.Literals(["human", "automatic"]),
    permission: Schema.optionalKey(Name),
    evidence: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("propose"),
    ...Operation,
    ...Connection,
    path: LibrarianPath,
    raw: Schema.NullOr(Text),
    expectedHash: Schema.NullOr(Hash),
    reason: Text,
    sources: Schema.Array(MemorySource),
    disposition: Schema.Literals(["human", "automatic"]),
    permission: Schema.optionalKey(Name),
    evidence: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("select"),
    ...Operation,
    ...Connection,
    view: Schema.Literals(["browse", "memory", "decision", "overview"]),
    path: Schema.optionalKey(LibrarianPath),
    changeId: Schema.optionalKey(Name),
    query: Schema.optionalKey(Text),
    directory: Schema.optionalKey(Schema.String),
    offset: Schema.optionalKey(Revision),
  }),
  Schema.Struct({
    action: Schema.Literal("undo"),
    ...Operation,
    ...Connection,
    changeId: Name,
    expectedRevisionHash: Hash,
    reason: Text,
    evidence: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("finish"),
    ...Operation,
    ...Connection,
    userRequest: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("interrupt"),
    ...Operation,
    ...Connection,
    userRequest: Text,
  }),
]);
export type LibrarianCommand = typeof LibrarianCommand.Type;
export const LibrarianReply = Schema.Struct({
  state: LibrarianView,
  capability: Schema.optionalKey(Name),
});
export type LibrarianReply = typeof LibrarianReply.Type;
export const LibrarianHumanCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("navigate"),
    ...Operation,
    view: Schema.Literals(Views),
    historyRunId: Schema.optionalKey(Name),
    path: Schema.optionalKey(LibrarianPath),
    changeId: Schema.optionalKey(Name),
    query: Schema.optionalKey(Text),
    directory: Schema.optionalKey(Schema.String),
    offset: Schema.optionalKey(Revision),
    filters: Schema.optionalKey(LibrarianFilters),
    trail: Schema.optionalKey(Trail),
    section: Schema.optionalKey(Schema.NullOr(Section)),
    focusPath: Schema.optionalKey(LibrarianPath),
    connections: Schema.optionalKey(LibrarianConnections),
    stages: Schema.optionalKey(LibrarianStages),
    activity: Schema.optionalKey(LibrarianActivity),
    returnChangeId: Schema.optionalKey(Name),
  }),
  Schema.Struct({
    action: Schema.Literal("decide"),
    ...Operation,
    runId: Name,
    changeId: Name,
    expectedRevisionHash: Hash,
    sources: Schema.Array(MemorySource),
    decision: Schema.Literals(["accept", "reject"]),
    reason: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("reminder"),
    ...Operation,
    enabled: Schema.optionalKey(Schema.Boolean),
    dismiss: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    ...Operation,
    comparison: Schema.optionalKey(Schema.Boolean),
    evidence: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type LibrarianHumanCommand = typeof LibrarianHumanCommand.Type;
export const LibrarianGuide = {
  workflow:
    "Dreaming begins only after the user asks their existing coding agent. Read librarian read, then librarian apply REQUEST.json with action start, a stable requestId, the displayed uiRevision, the existing sessionId and the exact user request. Omit automaticPermissions to allow the routine categories in routine; pass a narrower list only when the user names one, or [] when the user wants to decide every change. Scope never starts a model or agent. Continue the conversation in that existing session. Pick a bounded batch, do routine work yourself and present only judgment calls. Follow the okf-librarian workflow from irudd-okf skill install for what counts as routine. Finish requires a separate explicit conversational instruction.",
  routine: LibrarianRoutineWork,
  connection:
    "Start and explicit resume return a connection capability. All proposal and presentation changes need the active runId, sessionId and capability. Restart interrupts the queue and invalidates all capabilities. Resume only when the user requests it. Retry uncertain operations with the same requestId and exact payload. Reconcile conflicts from librarian read; the person browsing Librarian views also changes uiRevision.",
  decisions:
    "Propose sends file semantics to irudd-okf. Present references an existing immutable change. Routine work uses disposition automatic with its routine category as permission; Scope records the agent review with reason, actor, revisions and evidence for the completed overview. Category names are labels: irudd-okf decides which changes need a human and Scope then presents them for a human decision regardless of the requested disposition. Present judgment calls with disposition human. Human proposals appear one at a time with exact before and after, reasons and evidence. Only the Scope renderer can record a human decision. Ask the user to review the displayed proposal; never claim an agent decision was human. Proposals left pending by an older run keep their recorded review requirement; propose the same bytes again to get a fresh assessment. Outside edits, migrations and the user's own proposals stay with the user: irudd-okf refuses agent proposals for those files, so present the pending change with disposition human. Resume accepts automaticPermissions only when the user changes them. Amend with a new proposal or undo a completed change. Read returns the same projected content and uiRevision displayed by the UI.",
  setup:
    "librarian apply with action local and an absolute root connects a local bundle without Git. initialize true calls irudd-okf init only for a new empty location. Existing older bundles require user-directed migration through irudd-okf migration guide; connecting never migrates them. Git sync remains optional via memory connect OWNER/REPO.",
  schema: Schema.toJsonSchemaDocument(LibrarianCommand, { onExcessProperty: "error" }).schema,
};
