import { Schema } from "effect";
import { Artifact, ArtifactName, PublicationTabId, Revision } from "./index.ts";
import { PullRequestsStateObject as JsonObject } from "./pull-requests-state.ts";

export const MAX_RETRO_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_RETRO_REPLY_BYTES = 8 * 1024 * 1024;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(16384));
const Short = Schema.String.check(Schema.isMaxLength(512));
const Time = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.makeFilter(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
    {
      expected: "a valid UTC timestamp",
      toJsonSchema: () => ({ type: "string", format: "date-time" }),
    },
  ),
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
);
export const RetroRuntime = Schema.Literals(["codex", "claude"]);
export type RetroRuntime = typeof RetroRuntime.Type;
export const RetroIdentity = Schema.Struct({ sourceId: Id, runtime: RetroRuntime, sessionId: Id });
export type RetroIdentity = typeof RetroIdentity.Type;
export const RetroRepository = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => {
      const [host, ...parts] = value.split("/");
      return (
        parts.every((p) => p !== "" && p !== "." && p !== "..") &&
        (host !== "github.com" || (parts.length === 2 && value === value.toLowerCase()))
      );
    },
    { expected: "a canonical Git repository identity", toJsonSchema: () => ({ type: "string" }) },
  ),
  Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9_.~/-]+$/),
);
export const RetroDestination = Schema.Struct({
  id: Id,
  type: Schema.Literals([
    "file",
    "issue",
    "instructions",
    "claude-memory",
    "codex-instructions",
    "okf",
  ]),
  scope: Schema.Literals(["operator", "project"]),
  repository: Schema.optionalKey(RetroRepository),
  sourceId: Id,
  path: Short,
  available: Schema.Boolean,
  verifiedAt: Time,
});
export type RetroDestination = typeof RetroDestination.Type;
export const RetroConfiguration = Schema.Struct({
  version: Revision,
  sources: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Short,
      sshAlias: Schema.NullOr(Short),
      included: Schema.Boolean,
      runtimeRoots: Schema.Struct({ codex: Schema.NullOr(Short), claude: Schema.NullOr(Short) }),
      runtimes: Schema.Array(RetroRuntime).check(Schema.isMaxLength(2)),
    }),
  ).check(Schema.isMaxLength(100)),
  repositories: Schema.Array(
    Schema.Struct({ repository: RetroRepository, included: Schema.Boolean }),
  ).check(Schema.isMaxLength(1000)),
  memory: Schema.Struct({
    enabled: Schema.Boolean,
    destinations: Schema.Array(RetroDestination).check(Schema.isMaxLength(100)),
  }),
});
export type RetroConfiguration = typeof RetroConfiguration.Type;
export const emptyRetroConfiguration = (): RetroConfiguration => ({
  version: 0,
  sources: [],
  repositories: [],
  memory: { enabled: false, destinations: [] },
});
export const RetroSourceCoverage = Schema.Struct({
  sourceId: Id,
  runtime: RetroRuntime,
  availability: Schema.Literals(["available", "unavailable", "unsupported"]),
  inventoryComplete: Schema.Boolean,
  sessionCount: Revision,
  detail: Short,
  discoveredAt: Time,
  initialization: Schema.Literals(["none", "all", "from-now"]),
  override: Schema.optionalKey(Text),
});
export const RetroSession = Schema.Struct({
  ...RetroIdentity.fields,
  repository: RetroRepository,
  startedAt: Schema.NullOr(Time),
  lastActivityAt: Schema.NullOr(Time),
  status: Schema.Literals(["eligible", "reviewed", "failed", "ignored"]),
  evidence: Short,
});
export type RetroSession = typeof RetroSession.Type;
export const RetroMetric = Schema.Struct({
  name: Short,
  unit: Short,
  certainty: Schema.Literals(["exact", "estimated", "unknown"]),
  value: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
  evidence: Short,
  method: Short,
  coverage: Short,
});
export const RetroProposal = Schema.Struct({
  destination: RetroDestination,
  text: Text,
  kind: Schema.Literals(["correction", "memory"]),
});
export const RetroFinding = Schema.Struct({
  id: Id,
  category: Schema.Literals(["efficiency", "correctness", "speed", "workflow", "recurring"]),
  title: Short,
  text: Text,
  evidence: Schema.Array(Short).check(Schema.isMaxLength(20)),
  sessions: Schema.Array(RetroIdentity).check(Schema.isMaxLength(100)),
  proposal: Schema.optionalKey(RetroProposal),
});
export const RetroDecision = Schema.Struct({
  findingId: Id,
  decision: Schema.Literals(["accept", "edit", "reject"]),
  text: Text,
  destination: Schema.optionalKey(RetroDestination),
  at: Time,
});
export const RetroNote = Schema.Struct({
  id: PublicationTabId,
  findingId: Schema.NullOr(Id),
  text: Text,
  at: Time,
});
export const RetroRequest = Schema.Struct({
  ...RetroNote.fields,
  status: Schema.Literals(["pending", "answered", "declined"]),
  response: Text,
});
export const RetroOutcome = Schema.Struct({
  findingId: Id,
  status: Schema.Literals(["applied", "failed", "declined"]),
  evidence: Text,
});
export const RetroReport = Schema.Struct({
  destinations: Schema.Array(RetroDestination).check(Schema.isMaxLength(100)),
  summary: Text,
  agent: Schema.NullOr(RetroIdentity),
  sources: Schema.Array(RetroSourceCoverage).check(Schema.isMaxLength(200)),
  findings: Schema.Array(RetroFinding).check(Schema.isMaxLength(500)),
  metrics: Schema.Array(RetroMetric).check(Schema.isMaxLength(100)),
});
export type RetroReport = typeof RetroReport.Type;
export const RetroState = Schema.Struct({ version: Revision, value: JsonObject });
export const RetroSnapshot = Schema.Struct({
  permittedDestinations: Schema.Array(RetroDestination).check(Schema.isMaxLength(200)),
  memoryEnabled: Schema.Boolean,
  artifact: Artifact,
  tabId: PublicationTabId,
  version: Revision,
  status: Schema.Literals(["active", "finished"]),
  finishedAt: Schema.NullOr(Time),
  operatorInstruction: Schema.NullOr(Text),
  report: RetroReport,
  sessions: Schema.Array(RetroSession).check(Schema.isMaxLength(200)),
  next: Schema.NullOr(Text),
  decisions: Schema.Array(RetroDecision),
  comments: Schema.Array(RetroNote),
  requests: Schema.Array(RetroRequest),
  outcomes: Schema.Array(RetroOutcome),
  appState: RetroState,
});
export type RetroSnapshot = typeof RetroSnapshot.Type;
export const RetroHistoryEntry = Schema.Struct({
  artifact: Artifact,
  tabId: PublicationTabId,
  finishedAt: Time,
  summary: Text,
  reviewedSessions: Revision,
});
const Read = { name: ArtifactName, tabId: Schema.optionalKey(PublicationTabId) };
const Write = {
  name: ArtifactName,
  tabId: PublicationTabId,
  requestId: PublicationTabId,
  expectedVersion: Revision,
};
export const RetroCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("settings") }),
  Schema.Struct({
    action: Schema.Literal("configure"),
    requestId: PublicationTabId,
    expectedVersion: Revision,
    configuration: RetroConfiguration,
  }),
  Schema.Struct({
    action: Schema.Literal("tracking"),
    sourceId: Id,
    runtime: RetroRuntime,
    after: Schema.optionalKey(Id),
  }),
  Schema.Struct({ action: Schema.Literal("history"), after: Schema.optionalKey(Id) }),
  Schema.Struct({
    action: Schema.Literal("read"),
    ...Read,
    after: Schema.optionalKey(Text),
    version: Schema.optionalKey(Revision),
  }),
  Schema.Struct({ action: Schema.Literal("publish"), ...Write, report: RetroReport }),
  Schema.Struct({
    action: Schema.Literal("inventory"),
    ...Write,
    sessions: Schema.Array(RetroSession).check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    action: Schema.Literal("decide"),
    ...Write,
    findingId: Id,
    decision: Schema.Literals(["accept", "edit", "reject"]),
    text: Text,
    destination: Schema.optionalKey(RetroDestination),
  }),
  Schema.Struct({
    action: Schema.Literal("comment"),
    ...Write,
    findingId: Schema.NullOr(Id),
    text: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("request"),
    ...Write,
    findingId: Schema.NullOr(Id),
    text: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("resolve-request"),
    ...Write,
    id: PublicationTabId,
    status: Schema.Literals(["answered", "declined"]),
    response: Text,
  }),
  Schema.Struct({
    action: Schema.Literal("outcomes"),
    ...Write,
    outcomes: Schema.Array(RetroOutcome).check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({ action: Schema.Literal("state-read"), ...Read }),
  Schema.Struct({
    action: Schema.Literals(["state-set", "state-patch"]),
    ...Write,
    value: JsonObject,
  }),
  Schema.Struct({
    action: Schema.Literal("state-delete"),
    ...Write,
    keys: Schema.Array(Id).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({ action: Schema.Literal("finish"), ...Write, operatorInstruction: Text }),
]);
export type RetroCommand = typeof RetroCommand.Type;
export const RetroReply = Schema.Union([
  Schema.Struct({ type: Schema.Literal("configuration"), configuration: RetroConfiguration }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: RetroSnapshot }),
  Schema.Struct({
    type: Schema.Literal("receipt"),
    tabId: PublicationTabId,
    version: Revision,
    status: Schema.Literals(["active", "finished"]),
  }),
  Schema.Struct({ type: Schema.Literal("state"), tabId: PublicationTabId, state: RetroState }),
  Schema.Struct({
    type: Schema.Literal("history"),
    entries: Schema.Array(RetroHistoryEntry).check(Schema.isMaxLength(100)),
    next: Schema.NullOr(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("tracking"),
    initialized: Schema.Boolean,
    mode: Schema.NullOr(Schema.Literals(["all", "from-now"])),
    cutoff: Schema.NullOr(Time),
    audited: Schema.Array(Id).check(Schema.isMaxLength(200)),
    agents: Schema.Array(Id).check(Schema.isMaxLength(200)),
    next: Schema.NullOr(Id),
  }),
]);
export type RetroReply = typeof RetroReply.Type;

export function canonicalRetroRepository(origin: string): string | null {
  if (origin.length > 4096 || /\s/.test(origin.trim())) return null;
  let host: string;
  let path: string;
  let protocol = "ssh:";
  try {
    const scp = /^(?:[^@/]+@)?([A-Za-z0-9.-]+):([^/].*)$/.exec(origin.trim());
    if (scp && !origin.includes("://")) {
      host = scp[1];
      path = scp[2];
    } else {
      const url = new URL(origin);
      protocol = url.protocol;
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash)
        return null;
      const raw = /^[a-z]+:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(origin.trim());
      if (!raw) return null;
      host = raw[1].split("@").at(-1)!;
      path = (raw[2] ?? "").replace(/^\/+/, "");
    }
    host = host.toLowerCase();
    if (
      (protocol === "ssh:" && host === "github.com:22") ||
      (protocol === "https:" && host === "github.com:443")
    )
      host = "github.com";
    path = path.replace(/\/+$/, "").replace(/\.git$/, "");
    if (host === "github.com") {
      if (path.split("/").length !== 2) return null;
      path = path.toLowerCase();
    }
    const result = `${host}/${path}`;
    return !path.split("/").some((p) => !p || p === "." || p === "..") &&
      Schema.is(RetroRepository)(result)
      ? result
      : null;
  } catch {
    return null;
  }
}
