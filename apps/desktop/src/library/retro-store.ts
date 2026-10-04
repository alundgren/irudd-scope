import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Artifact, decode, ScopeError, type LiveEvent } from "@irudd-scope/protocol";
import {
  RetroCommand,
  RetroReply,
  RetroReport,
  RetroState,
  type RetroConfiguration,
  type RetroSnapshot,
  type RetroSession,
} from "@irudd-scope/protocol/retro";
import type { PlanDatabase } from "./plan-store.ts";

type Document = {
  -readonly [
    K in keyof Omit<
      RetroSnapshot,
      "artifact" | "tabId" | "sessions" | "next" | "permittedDestinations" | "memoryEnabled"
    >
  ]: Omit<
    RetroSnapshot,
    "artifact" | "tabId" | "sessions" | "next" | "permittedDestinations" | "memoryEnabled"
  >[K];
};
const emptyDocument = (): Document => ({
  version: 0,
  status: "active",
  finishedAt: null,
  operatorInstruction: null,
  report: { destinations: [], summary: "", agent: null, sources: [], findings: [], metrics: [] },
  decisions: [],
  comments: [],
  requests: [],
  outcomes: [],
  appState: { version: 0, value: {} },
});
const identity = (value: { sourceId: string; runtime: string; sessionId: string }) =>
  JSON.stringify([value.sourceId, value.runtime, value.sessionId]);
const sourceKey = (value: { sourceId: string; runtime: string }) =>
  JSON.stringify([value.sourceId, value.runtime]);
function isLaterThan(value: string, cutoff: string): boolean {
  const seconds = value.slice(0, 19);
  const limit = cutoff.slice(0, 19);
  if (seconds !== limit) return seconds > limit;
  const fraction = (timestamp: string) =>
    timestamp.slice(19, -1).replace(/^\./, "").padEnd(19, "0");
  return fraction(value) > fraction(cutoff);
}

export function initializeRetroTab(sql: PlanDatabase["sql"], tabId: string, artifact: Artifact) {
  return Effect.gen(function* () {
    if (artifact.kind !== "retro") return;
    yield* sql`INSERT INTO retro_reports(tab_id, document) VALUES (${tabId}, ${JSON.stringify(emptyDocument())}) ON CONFLICT(tab_id) DO NOTHING`;
  });
}

export class RetroStore {
  private beforeFinish?: (command: Extract<RetroCommand, { action: "finish" }>) => Promise<void>;
  setBeforeFinish(callback: typeof this.beforeFinish) {
    this.beforeFinish = callback;
  }
  private configuration?: {
    read: () => Promise<RetroConfiguration>;
    configure: (
      command: Extract<RetroCommand, { action: "configure" }>,
    ) => Promise<RetroConfiguration>;
  };
  constructor(private readonly database: PlanDatabase) {}
  setConfiguration(handlers: typeof this.configuration) {
    this.configuration = handlers;
  }
  async initialize() {
    const { sql, run } = this.database;
    await run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS retro_reports(tab_id TEXT PRIMARY KEY REFERENCES live_tabs(id) ON DELETE CASCADE, document TEXT NOT NULL CHECK(json_valid(document))) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS retro_sessions(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, identity TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), PRIMARY KEY(tab_id,identity)) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS retro_receipts(tab_id TEXT NOT NULL REFERENCES live_tabs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, payload TEXT NOT NULL, reply TEXT NOT NULL CHECK(json_valid(reply)), PRIMARY KEY(tab_id,request_id)) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS retro_audits(source_id TEXT NOT NULL, runtime TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('reviewed','agent')), at TEXT NOT NULL, PRIMARY KEY(source_id,runtime,session_id,role)) STRICT`;
          yield* sql`CREATE TABLE IF NOT EXISTS retro_initialization(source_id TEXT NOT NULL, runtime TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('all','from-now')), cutoff TEXT NOT NULL, PRIMARY KEY(source_id,runtime)) STRICT`;
          yield* sql`PRAGMA user_version = 11`;
          const rows = yield* sql<{
            tab_id: string;
            document: string;
          }>`SELECT tab_id,document FROM artifacts WHERE json_extract(document,'$.kind') = 'retro'`;
          for (const row of rows)
            yield* initializeRetroTab(sql, row.tab_id, decode(Artifact, JSON.parse(row.document)));
        }),
      ),
    );
  }
  async command(input: RetroCommand): Promise<RetroReply> {
    const command = decode(RetroCommand, input);
    if (command.action === "finish" && this.beforeFinish) {
      const [owner] = await this.database.run(
        this.database.sql<{
          document: string;
        }>`SELECT retro_reports.document FROM artifacts JOIN retro_reports ON retro_reports.tab_id = artifacts.tab_id WHERE artifacts.tab_id = ${command.tabId} AND json_extract(artifacts.document,'$.name') = ${command.name}`,
      );
      if (owner && (JSON.parse(owner.document) as Document).status === "active") {
        try {
          await this.beforeFinish(command);
        } catch (error) {
          throw new ScopeError(
            409,
            error instanceof Error
              ? error.message
              : "Could not flush retrospective edits before finishing.",
          );
        }
      }
    }
    if (command.action === "settings" || command.action === "configure") {
      if (!this.configuration)
        throw new ScopeError(503, "Retrospective configuration is unavailable.");
      return {
        type: "configuration",
        configuration:
          command.action === "settings"
            ? await this.configuration.read()
            : await this.configuration.configure(command),
      };
    }
    const configuration = ["read", "publish", "inventory", "decide", "finish"].includes(
      command.action,
    )
      ? await this.configuration?.read()
      : undefined;
    const { sql, mutate } = this.database;
    return mutate(
      sql.withTransaction(
        Effect.gen(function* () {
          const fail = (message: string, status = 409) =>
            Effect.fail(new ScopeError(status, message));
          if (command.action === "tracking") {
            const [init] = yield* sql<{
              mode: "all" | "from-now";
              cutoff: string;
            }>`SELECT mode,cutoff FROM retro_initialization WHERE source_id = ${command.sourceId} AND runtime = ${command.runtime}`;
            const rows = yield* sql<{
              session_id: string;
              reviewed: number;
              agent: number;
            }>`SELECT session_id,max(role = 'reviewed') AS reviewed,max(role = 'agent') AS agent FROM retro_audits WHERE source_id = ${command.sourceId} AND runtime = ${command.runtime} AND session_id > ${command.after ?? ""} GROUP BY session_id ORDER BY session_id LIMIT 201`;
            const page = rows.slice(0, 200);
            return {
              reply: {
                type: "tracking",
                initialized: !!init,
                mode: init?.mode ?? null,
                cutoff: init?.cutoff ?? null,
                audited: page.filter((r) => r.reviewed).map((r) => r.session_id),
                agents: page.filter((r) => r.agent).map((r) => r.session_id),
                next: rows.length > 200 ? page.at(-1)!.session_id : null,
              } as RetroReply,
              events: [],
            };
          }
          if (command.action === "history") {
            const cursor = command.after?.split("|");
            if (cursor && (cursor.length !== 2 || !Number.isFinite(Date.parse(cursor[0]))))
              return yield* fail("Invalid history cursor.", 400);
            const before = cursor?.[0] ?? "9999";
            const beforeId = cursor?.[1] ?? "";
            const rows = yield* sql<{
              tab_id: string;
              artifact: string;
              document: string;
              count: number;
            }>`SELECT artifacts.tab_id,artifacts.document AS artifact,retro_reports.document, (SELECT count(*) FROM retro_sessions WHERE retro_sessions.tab_id = artifacts.tab_id AND json_extract(retro_sessions.document,'$.status') = 'reviewed') AS count FROM artifacts JOIN retro_reports ON retro_reports.tab_id = artifacts.tab_id WHERE json_extract(retro_reports.document,'$.status') = 'finished' AND (json_extract(retro_reports.document,'$.finishedAt') < ${before} OR (json_extract(retro_reports.document,'$.finishedAt') = ${before} AND artifacts.tab_id < ${beforeId})) ORDER BY json_extract(retro_reports.document,'$.finishedAt') DESC,artifacts.tab_id DESC LIMIT 101`;
            const page = rows.slice(0, 100);
            return {
              reply: {
                type: "history",
                entries: page.map((row) => {
                  const d = JSON.parse(row.document) as Document;
                  return {
                    artifact: decode(Artifact, JSON.parse(row.artifact)),
                    tabId: row.tab_id,
                    finishedAt: d.finishedAt!,
                    summary: d.report.summary,
                    reviewedSessions: row.count,
                  };
                }),
                next:
                  rows.length > 100
                    ? `${(JSON.parse(page.at(-1)!.document) as Document).finishedAt}|${page.at(-1)!.tab_id}`
                    : null,
              } as RetroReply,
              events: [],
            };
          }
          const [owner] = yield* sql<{
            tab_id: string;
            artifact: string;
            document: string;
            trashed_at: number | null;
          }>`SELECT artifacts.tab_id,artifacts.document AS artifact,retro_reports.document,live_tabs.trashed_at FROM artifacts JOIN retro_reports ON retro_reports.tab_id = artifacts.tab_id JOIN live_tabs ON live_tabs.id = artifacts.tab_id WHERE json_extract(artifacts.document,'$.name') = ${command.name}`;
          if (!owner) return yield* fail("Named retrospective not found.", 404);
          if (command.tabId && command.tabId !== owner.tab_id)
            return yield* fail("This retrospective belongs to a different tab.");
          const artifact = decode(Artifact, JSON.parse(owner.artifact));
          const document = JSON.parse(owner.document) as Document;
          if (command.action === "state-read")
            return {
              reply: { type: "state", tabId: owner.tab_id, state: document.appState } as RetroReply,
              events: [],
            };
          if (command.action === "read") {
            if (command.version !== undefined && command.version !== document.version)
              return yield* fail("Retrospective changed. Restart the paginated read.");
            const sessions = yield* sql<{
              identity: string;
              document: string;
            }>`SELECT identity,document FROM retro_sessions WHERE tab_id = ${owner.tab_id} AND identity > ${command.after ?? ""} ORDER BY identity LIMIT 201`;
            return {
              reply: {
                type: "snapshot",
                snapshot: {
                  ...document,
                  memoryEnabled: configuration?.memory.enabled ?? false,
                  permittedDestinations: [
                    ...document.report.destinations,
                    ...(configuration?.memory.destinations ?? []),
                  ].filter(
                    (d, index, array) =>
                      d.available && array.findIndex((other) => other.id === d.id) === index,
                  ),
                  report:
                    document.status === "active" && !configuration?.memory.enabled
                      ? {
                          ...document.report,
                          findings: document.report.findings.map((f) =>
                            f.proposal?.kind === "memory"
                              ? Object.fromEntries(
                                  Object.entries(f).filter(([key]) => key !== "proposal"),
                                )
                              : f,
                          ),
                        }
                      : document.report,
                  artifact,
                  tabId: owner.tab_id,
                  sessions: sessions.slice(0, 200).map((s) => JSON.parse(s.document)),
                  next: sessions.length > 200 ? sessions[199].identity : null,
                },
              } as RetroReply,
              events: [],
            };
          }
          const payload = createHash("sha256")
            .update(
              JSON.stringify(command, (_key, value: unknown) =>
                value && typeof value === "object" && !Array.isArray(value)
                  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
                  : value,
              ),
            )
            .digest("hex");
          const [receipt] = yield* sql<{
            payload: string;
            reply: string;
          }>`SELECT payload,reply FROM retro_receipts WHERE tab_id = ${owner.tab_id} AND request_id = ${command.requestId}`;
          if (receipt) {
            if (receipt.payload !== payload)
              return yield* fail("This request ID was already used with different content.");
            return { reply: decode(RetroReply, JSON.parse(receipt.reply)), events: [] };
          }
          if (document.status === "finished")
            return yield* fail("Finished retrospectives are read-only.");
          if (owner.trashed_at !== null)
            return yield* fail("This retrospective is in Trashcan. Restore it before updating.");
          const stateWrite = command.action.startsWith("state-");
          if (
            command.expectedVersion !== (stateWrite ? document.appState.version : document.version)
          )
            return yield* fail("Retrospective changed. Read the current version before updating.");
          const now = new Date().toISOString();
          const finding =
            "findingId" in command && command.findingId !== null
              ? document.report.findings.find((f) => f.id === command.findingId)
              : undefined;
          if ("findingId" in command && command.findingId !== null && !finding)
            return yield* fail("Finding not found.", 400);
          let event: "changed" | "decision" | "comment" | "request" | "finished" = "changed";
          const permittedDestination = (
            destination: NonNullable<RetroReport["findings"][number]["proposal"]>["destination"],
          ) =>
            configuration?.memory.destinations.some(
              (d) =>
                d.id === destination.id &&
                JSON.stringify(d) === JSON.stringify(destination) &&
                d.available &&
                configuration.sources.some((s) => s.id === d.sourceId && s.included) &&
                (!d.repository ||
                  configuration.repositories.some(
                    (r) => r.repository === d.repository && r.included,
                  )),
            );
          const allowedDestination = (
            destination: NonNullable<RetroReport["findings"][number]["proposal"]>["destination"],
            kind: "memory" | "correction" = "correction",
          ) =>
            permittedDestination(destination) ||
            (kind === "correction" &&
              ["file", "issue", "instructions", "codex-instructions"].includes(destination.type) &&
              (command.action === "publish" ? command.report : document.report).destinations.some(
                (d) =>
                  d.available &&
                  d.id === destination.id &&
                  JSON.stringify(d) === JSON.stringify(destination),
              ));
          switch (command.action) {
            case "publish": {
              const ids = command.report.findings.map((f) => f.id);
              if (new Set(ids).size !== ids.length)
                return yield* fail("Finding IDs must be distinct.", 400);
              for (const d of command.report.destinations) {
                if (!configuration?.sources.some((s) => s.id === d.sourceId && s.included))
                  return yield* fail("Destination must reference an included source.", 400);
                if (
                  (d.scope === "project") !== !!d.repository ||
                  (d.repository &&
                    !configuration.repositories.some(
                      (r) => r.repository === d.repository && r.included,
                    ))
                )
                  return yield* fail("Destination scope must match an included repository.", 400);
                if (d.type === "claude-memory" && d.scope !== "project")
                  return yield* fail(
                    "Claude memory destinations require their project repository.",
                    400,
                  );
              }
              const sources = command.report.sources.map(sourceKey);
              if (new Set(sources).size !== sources.length)
                return yield* fail("Source/runtime pairs must be distinct.", 400);
              for (const record of [
                ...document.decisions,
                ...document.comments,
                ...document.requests,
                ...document.outcomes,
              ])
                if (record.findingId && !ids.includes(record.findingId))
                  return yield* fail(
                    "Publication cannot remove findings with human review records.",
                  );
              for (const source of command.report.sources) {
                if (
                  !configuration?.sources.some(
                    (s) =>
                      s.id === source.sourceId && s.included && s.runtimes.includes(source.runtime),
                  )
                )
                  return yield* fail("Coverage must reference an included configured source.", 400);
                if (source.availability !== "available" && source.initialization !== "none")
                  return yield* fail("An unavailable runtime cannot initialize.", 400);
              }
              for (const f of command.report.findings)
                if (f.proposal) {
                  if (
                    ["claude-memory", "okf"].includes(f.proposal.destination.type) &&
                    f.proposal.kind !== "memory"
                  )
                    return yield* fail(
                      "Native memory destinations require a memory proposal.",
                      400,
                    );
                  if (f.proposal.kind === "memory" && !configuration?.memory.enabled)
                    return yield* fail("Memory proposals are disabled.", 400);
                  if (!allowedDestination(f.proposal.destination, f.proposal.kind))
                    return yield* fail(
                      "Proposal destination must match a verified permitted capability.",
                      400,
                    );
                }
              for (const metric of command.report.metrics)
                if ((metric.certainty === "unknown") !== (metric.value === null))
                  return yield* fail(
                    "Unknown metrics require null; exact or estimated metrics require a value.",
                    400,
                  );
              for (const decision of document.decisions) {
                const before = document.report.findings.find((f) => f.id === decision.findingId);
                const after = command.report.findings.find((f) => f.id === decision.findingId);
                if (JSON.stringify(before?.proposal) !== JSON.stringify(after?.proposal))
                  return yield* fail(
                    "Decided proposals cannot change. Publish a new finding for reconsideration.",
                  );
              }
              document.report = decode(RetroReport, command.report);
              if (command.report.agent) {
                const a = command.report.agent;
                yield* sql`INSERT INTO retro_audits(source_id,runtime,session_id,role,at) VALUES (${a.sourceId},${a.runtime},${a.sessionId},'agent',${now}) ON CONFLICT DO NOTHING`;
              }
              break;
            }
            case "inventory": {
              for (const session of command.sessions) {
                const source = document.report.sources.find(
                  (s) => sourceKey(s) === sourceKey(session),
                );
                if (
                  !source ||
                  (source.availability !== "available" &&
                    !["ignored", "failed"].includes(session.status))
                )
                  return yield* fail("Inventory requires saved available source coverage.", 400);
                if (
                  !configuration?.repositories.some(
                    (r) => r.repository === session.repository && r.included,
                  )
                )
                  return yield* fail("Inventory requires an included configured repository.", 400);
                const [audit] =
                  yield* sql`SELECT 1 FROM retro_audits WHERE source_id = ${session.sourceId} AND runtime = ${session.runtime} AND session_id = ${session.sessionId}`;
                const [init] = yield* sql<{
                  mode: string;
                  cutoff: string;
                }>`SELECT mode,cutoff FROM retro_initialization WHERE source_id = ${session.sourceId} AND runtime = ${session.runtime}`;
                if (
                  session.status !== "ignored" &&
                  (audit ||
                    (document.report.agent &&
                      identity(document.report.agent) === identity(session)) ||
                    (init?.mode === "from-now" &&
                      (!session.startedAt || !isLaterThan(session.startedAt, init.cutoff))))
                )
                  return yield* fail("This session is excluded from automatic review.", 400);
                if (session.startedAt && isLaterThan(session.startedAt, source.discoveredAt))
                  return yield* fail("Session started after the discovery cutoff.", 400);
                if (
                  session.lastActivityAt &&
                  isLaterThan(session.lastActivityAt, source.discoveredAt)
                )
                  return yield* fail("Session activity exceeds the discovery cutoff.", 400);
                if (source.initialization === "from-now" && session.status === "reviewed")
                  return yield* fail("Start now does not audit earlier sessions.", 400);
                yield* sql`INSERT INTO retro_sessions(tab_id,identity,document) VALUES (${owner.tab_id}, ${identity(session)},${JSON.stringify(session)}) ON CONFLICT(tab_id,identity) DO UPDATE SET document = excluded.document`;
              }
              break;
            }
            case "decide":
              if (
                command.destination &&
                ["claude-memory", "okf"].includes(command.destination.type) &&
                finding?.proposal?.kind !== "memory"
              )
                return yield* fail("Native memory destinations require a memory proposal.", 400);
              if (!finding?.proposal)
                return yield* fail("This finding has no correction proposal.", 400);
              if (
                command.decision !== "reject" &&
                !allowedDestination(
                  command.destination ?? finding.proposal.destination,
                  finding.proposal.kind,
                )
              )
                return yield* fail(
                  "Edited destination must match a verified permitted capability.",
                  400,
                );
              if (
                command.decision !== "reject" &&
                finding?.proposal?.kind === "memory" &&
                !configuration?.memory.enabled
              )
                return yield* fail("Memory proposals are disabled.", 400);
              document.decisions = document.decisions.filter(
                (d) => d.findingId !== command.findingId,
              );
              document.decisions = [
                ...document.decisions,
                {
                  findingId: command.findingId,
                  decision: command.decision,
                  text: command.decision === "accept" ? finding.proposal.text : command.text,
                  destination: command.destination ?? finding.proposal.destination,
                  at: now,
                },
              ];
              document.outcomes = document.outcomes.filter(
                (o) => o.findingId !== command.findingId,
              );
              event = "decision";
              break;
            case "comment":
              document.comments = [
                ...document.comments,
                {
                  id: command.requestId,
                  findingId: command.findingId,
                  text: command.text,
                  at: now,
                },
              ];
              event = "comment";
              break;
            case "request":
              document.requests = [
                ...document.requests,
                {
                  id: command.requestId,
                  findingId: command.findingId,
                  text: command.text,
                  at: now,
                  status: "pending",
                  response: "",
                },
              ];
              event = "request";
              break;
            case "resolve-request": {
              const request = document.requests.find((r) => r.id === command.id);
              if (!request) return yield* fail("Investigation request not found.", 400);
              document.requests = document.requests.map((r) =>
                r.id === command.id
                  ? { ...r, status: command.status, response: command.response }
                  : r,
              );
              break;
            }
            case "outcomes": {
              if (
                new Set(command.outcomes.map((o) => o.findingId)).size !== command.outcomes.length
              )
                return yield* fail("Outcome finding IDs must be distinct.", 400);
              for (const outcome of command.outcomes)
                if (
                  !document.decisions.some(
                    (d) => d.findingId === outcome.findingId && d.decision !== "reject",
                  ) ||
                  !outcome.evidence.trim()
                )
                  return yield* fail("Outcomes require an accepted correction and evidence.", 400);
              document.outcomes = [
                ...document.outcomes.filter(
                  (o) => !command.outcomes.some((n) => n.findingId === o.findingId),
                ),
                ...command.outcomes,
              ];
              break;
            }
            case "state-set":
              document.appState = { version: document.appState.version + 1, value: command.value };
              break;
            case "state-patch":
              document.appState = decode(RetroState, {
                version: document.appState.version + 1,
                value: { ...document.appState.value, ...command.value },
              });
              break;
            case "state-delete": {
              const value = { ...document.appState.value };
              for (const key of command.keys) delete value[key];
              document.appState = { version: document.appState.version + 1, value };
              break;
            }
            case "finish": {
              if (!document.report.agent)
                return yield* fail(
                  "Save the current retrospective agent identity before finishing.",
                  400,
                );
              if (!command.operatorInstruction.trim())
                return yield* fail("Finish requires the operator's explicit instruction.", 400);
              if (document.requests.some((r) => r.status === "pending"))
                return yield* fail("Resolve pending investigation requests before finishing.");
              for (const decision of document.decisions)
                if (
                  decision.decision !== "reject" &&
                  !document.outcomes.some((o) => o.findingId === decision.findingId)
                )
                  return yield* fail(
                    "Record applied, failed, or declined outcomes for every accepted correction before finishing.",
                  );
              for (const selected of configuration?.sources.filter((s) => s.included) ?? [])
                for (const runtime of selected.runtimes)
                  if (
                    !document.report.sources.some(
                      (s) => s.sourceId === selected.id && s.runtime === runtime,
                    )
                  )
                    return yield* fail(
                      "Save availability coverage for every selected source/runtime before finishing.",
                    );
              for (const source of document.report.sources) {
                if (source.availability === "available") {
                  if (!source.inventoryComplete)
                    return yield* fail(
                      "Finish requires complete discovery for every available runtime.",
                    );
                  const [{ count }] = yield* sql<{
                    count: number;
                  }>`SELECT count(*) AS count FROM retro_sessions WHERE tab_id = ${owner.tab_id} AND json_extract(document,'$.sourceId') = ${source.sourceId} AND json_extract(document,'$.runtime') = ${source.runtime}`;
                  if (count !== source.sessionCount)
                    return yield* fail(
                      "Saved inventory does not match the declared session count.",
                    );
                  const [initialized] =
                    yield* sql`SELECT 1 FROM retro_initialization WHERE source_id = ${source.sourceId} AND runtime = ${source.runtime}`;
                  if (initialized && source.initialization !== "none")
                    return yield* fail(
                      "Source tracking changed. Read tracking and reselect the report before finishing.",
                    );
                  if (!initialized && source.initialization === "none")
                    return yield* fail(
                      "Choose All or Start now for every available uninitialized runtime.",
                    );
                }
                if (source.availability !== "available") {
                  if (!source.override?.trim())
                    return yield* fail(
                      "Record the operator's override for every unavailable selected runtime.",
                    );
                  continue;
                }
                if (source.initialization !== "none")
                  yield* sql`INSERT INTO retro_initialization(source_id,runtime,mode,cutoff) VALUES (${source.sourceId},${source.runtime},${source.initialization},${source.discoveredAt}) ON CONFLICT(source_id,runtime) DO NOTHING`;
              }
              const sessions = yield* sql<{
                document: string;
              }>`SELECT document FROM retro_sessions WHERE tab_id = ${owner.tab_id}`;
              for (const row of sessions) {
                const s = JSON.parse(row.document) as RetroSession;
                const source = document.report.sources.find((c) => sourceKey(c) === sourceKey(s));
                if (s.status !== "reviewed") continue;
                if (source?.availability !== "available")
                  return yield* fail("Reviewed sessions require available saved coverage.");
                const [audit] =
                  yield* sql`SELECT 1 FROM retro_audits WHERE source_id = ${s.sourceId} AND runtime = ${s.runtime} AND session_id = ${s.sessionId}`;
                const [init] = yield* sql<{
                  mode: string;
                  cutoff: string;
                }>`SELECT mode,cutoff FROM retro_initialization WHERE source_id = ${s.sourceId} AND runtime = ${s.runtime}`;
                if (
                  audit ||
                  identity(document.report.agent) === identity(s) ||
                  !configuration?.repositories.some(
                    (r) => r.repository === s.repository && r.included,
                  ) ||
                  (init?.mode === "from-now" &&
                    (!s.startedAt || !isLaterThan(s.startedAt, init.cutoff)))
                )
                  return yield* fail(
                    "Session inclusion or tracking changed. Read tracking and reselect before finishing.",
                  );
                if (
                  (s.startedAt && isLaterThan(s.startedAt, source.discoveredAt)) ||
                  (s.lastActivityAt && isLaterThan(s.lastActivityAt, source.discoveredAt)) ||
                  source.initialization === "from-now"
                )
                  return yield* fail("Reviewed session is outside saved coverage.");
                yield* sql`INSERT INTO retro_audits(source_id,runtime,session_id,role,at) VALUES (${s.sourceId},${s.runtime},${s.sessionId},'reviewed',${now}) ON CONFLICT DO NOTHING`;
              }
              if (document.report.agent) {
                const a = document.report.agent;
                yield* sql`INSERT INTO retro_audits(source_id,runtime,session_id,role,at) VALUES (${a.sourceId},${a.runtime},${a.sessionId},'agent',${now}) ON CONFLICT DO NOTHING`;
              }
              document.status = "finished";
              document.finishedAt = now;
              document.operatorInstruction = command.operatorInstruction;
              event = "finished";
              yield* sql`UPDATE live_tabs SET permanent = 1 WHERE id = ${owner.tab_id}`;
              break;
            }
          }
          document.version++;
          if (Buffer.byteLength(JSON.stringify(document)) > 2.5 * 1024 * 1024)
            return yield* fail("Retrospective records exceed 2.5 MiB.", 413);
          yield* sql`UPDATE retro_reports SET document = ${JSON.stringify(document)} WHERE tab_id = ${owner.tab_id}`;
          const reply: RetroReply = stateWrite
            ? { type: "state", tabId: owner.tab_id, state: document.appState }
            : {
                type: "receipt",
                tabId: owner.tab_id,
                version: document.version,
                status: document.status,
              };
          yield* sql`INSERT INTO retro_receipts(tab_id,request_id,payload,reply) VALUES (${owner.tab_id},${command.requestId},${payload},${JSON.stringify(reply)})`;
          return {
            reply,
            events: [
              {
                type: "retro",
                id: artifact.id,
                name: command.name,
                tabId: owner.tab_id,
                version: document.version,
                event,
              },
            ] as LiveEvent[],
          };
        }),
      ),
      (result) => result.events,
    ).then((result) => decode(RetroReply, result.reply));
  }
}
