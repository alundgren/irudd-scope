import { DatabaseSync } from "node:sqlite";
import {
  addTokens,
  emptyTokens,
  type SessionCall,
  type SessionMessage,
  type SessionThread,
} from "./contract.ts";
import type { Prices } from "./prices.ts";
import {
  between,
  hideSecrets,
  inputText,
  num,
  outputFields,
  parseJson,
  record,
  str,
  toolName,
} from "./text.ts";

const TOOL_TYPES = [
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
];
const HARNESS: Record<string, string> = { claudeAgent: "claude", codex: "codex" };

type Row = Record<string, unknown>;

export type T3Read = {
  threads: Map<string, SessionThread>;
  calls: SessionCall[];
  /** Each native session or rollout id T3 knows, with its thread. */
  native: Map<string, string>;
};

type Query = (sql: string, ...params: Array<string | number>) => Row[];
type Run = SessionMessage & { threadId: string; provider: string | null };

function readThreads(all: Query, since: string) {
  const projects = new Map(
    all("select project_id, title from projection_projects").map((row) => [
      String(row.project_id),
      str(row.title) ?? "",
    ]),
  );
  const threads = new Map<string, SessionThread>();
  for (const row of all(
    "select thread_id, project_id, title, created_at from orchestration_v2_projection_threads where updated_at >= ? and deleted_at is null",
    since,
  )) {
    const id = String(row.thread_id);
    threads.set(id, {
      id,
      title: str(row.title) ?? "",
      project: projects.get(String(row.project_id)) ?? "No project",
      parentId: null,
      origin: null,
      createdAt: str(row.created_at) ?? "",
      messages: [],
      tokens: emptyTokens(),
      cost: 0,
      models: [],
      instructions: "",
      outcome: "",
    });
  }
  for (const row of all(
    "select thread_id, child_thread_id, origin from orchestration_v2_projection_subagents where updated_at >= ?",
    since,
  )) {
    const child = threads.get(String(row.child_thread_id));
    if (!child || !threads.has(String(row.thread_id))) continue;
    child.parentId = String(row.thread_id);
    child.origin = str(row.origin);
  }
  return threads;
}

function toRun(row: Row, threadId: string): Run {
  const payload = parseJson(row.payload_json);
  const selection = record(payload.modelSelection);
  const options = new Map(
    (Array.isArray(selection.options) ? selection.options : []).map((option) => [
      record(option).id,
      record(option).value,
    ]),
  );
  const requestedAt = str(row.requested_at);
  const completedAt = str(row.completed_at);
  return {
    threadId,
    provider: str(row.provider),
    ordinal: num(row.ordinal),
    model: str(selection.model),
    effort: str(options.get("effort")) ?? str(options.get("reasoningEffort")),
    fast: options.get("fastMode") === true || options.get("serviceTier") === "priority",
    status: str(row.status) ?? "",
    requestedAt,
    completedAt,
    durationMs: between(str(payload.startedAt) ?? requestedAt, completedAt),
    tokens: null,
    cost: null,
    contextUsed: null,
    contextMax: null,
  };
}

function addTurn(run: Run, payload: Record<string, unknown>) {
  const usage = record(payload.turnTokenUsage);
  const context = record(payload.tokenUsage);
  if (Object.keys(usage).length) {
    const input = num(usage.inputTokens);
    const read = num(usage.cachedInputTokens);
    const write = num(usage.cacheCreationTokens);
    // T3 does not split Claude cache writes; Claude Code writes the 1-hour cache.
    const hour = run.provider === "claudeAgent" ? write : 0;
    addTokens((run.tokens ??= emptyTokens()), {
      uncached: Math.max(input - read - write, 0),
      cacheRead: read,
      cacheWrite5m: write - hour,
      cacheWrite1h: hour,
      output: num(usage.outputTokens),
      reasoning: num(usage.reasoningTokens),
    });
  }
  if (typeof context.usedTokens === "number") run.contextUsed = context.usedTokens;
  if (typeof context.maxTokens === "number") run.contextMax = context.maxTokens;
}

/** Each thread's messages with their tokens, and which run each provider turn belongs to. */
function readRuns(all: Query, since: string, threads: Map<string, SessionThread>, prices: Prices) {
  const runs = new Map<string, Run>();
  for (const row of all(
    "select run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json from orchestration_v2_projection_runs where requested_at >= ? or completed_at >= ? or completed_at is null",
    since,
    since,
  )) {
    const thread = threads.get(String(row.thread_id));
    if (thread) runs.set(String(row.run_id), toRun(row, thread.id));
  }
  const attemptRun = new Map(
    all("select attempt_id, run_id from orchestration_v2_projection_run_attempts").map((row) => [
      String(row.attempt_id),
      String(row.run_id),
    ]),
  );
  const turnRun = new Map<string, Run>();
  for (const row of all(
    "select provider_turn_id, run_attempt_id, payload_json from orchestration_v2_projection_provider_turns where started_at >= ? or completed_at >= ? or completed_at is null",
    since,
    since,
  )) {
    const run = runs.get(attemptRun.get(String(row.run_attempt_id)) ?? "");
    if (!run) continue;
    turnRun.set(String(row.provider_turn_id), run);
    addTurn(run, parseJson(row.payload_json));
  }
  for (const run of runs.values()) {
    const thread = threads.get(run.threadId)!;
    if (run.tokens) {
      run.cost = prices(run.model, run.tokens);
      addTokens(thread.tokens, run.tokens);
      thread.cost += run.cost ?? 0;
    }
    if (run.model && !thread.models.includes(run.model)) thread.models.push(run.model);
    const { threadId: _thread, provider: _provider, ...message } = run;
    thread.messages.push(message);
  }
  for (const thread of threads.values()) thread.messages.sort((a, b) => a.ordinal - b.ordinal);
  return { runs, turnRun };
}

function readCalls(
  all: Query,
  since: string,
  threads: Map<string, SessionThread>,
  { runs, turnRun }: ReturnType<typeof readRuns>,
) {
  const firstRun = new Map<string, Run>();
  for (const run of runs.values())
    if ((firstRun.get(run.threadId)?.ordinal ?? Infinity) > run.ordinal)
      firstRun.set(run.threadId, run);
  const calls: SessionCall[] = [];
  for (const row of all(
    `select thread_id, provider_turn_id, run_id, type, status, payload_json from orchestration_v2_projection_turn_items where updated_at >= ? and type in (${TOOL_TYPES.map(() => "?").join(",")}) order by ordinal`,
    since,
    ...TOOL_TYPES,
  )) {
    const thread = threads.get(String(row.thread_id));
    if (!thread) continue;
    // Provider-native subagent items have no T3 turn, and some have no run either.
    const run = turnRun.get(String(row.provider_turn_id)) ?? runs.get(String(row.run_id));
    const owner = run ?? firstRun.get(thread.id);
    const payload = parseJson(row.payload_json);
    const type = String(row.type);
    const startedAt = str(payload.startedAt);
    calls.push({
      threadId: thread.id,
      message: run?.ordinal ?? null,
      model: owner?.model ?? null,
      harness: HARNESS[owner?.provider ?? ""] ?? owner?.provider ?? null,
      kind: type,
      name: type === "command_execution" ? "shell" : toolName(str(payload.toolName) ?? type),
      input: inputText(payload.input),
      status: str(row.status) ?? "",
      exit: typeof payload.exitCode === "number" ? payload.exitCode : null,
      startedAt,
      durationMs: between(startedAt, payload.completedAt),
      ...outputFields(payload.output),
    });
  }
  return calls;
}

/** The first message from the person and the agent's last reply in each thread. */
function readMessages(db: DatabaseSync, threads: Map<string, SessionThread>) {
  const statement = db.prepare(
    "select role, payload_json from orchestration_v2_projection_messages where thread_id = ? and streaming = 0 order by created_at",
  );
  for (const thread of threads.values()) {
    let first = "";
    let last = "";
    for (const row of statement.all(thread.id) as Row[]) {
      const text = (str(parseJson(row.payload_json).text) ?? "").trim();
      if (!text) continue;
      if (row.role === "user" && !first) first = text;
      if (row.role === "assistant") last = text;
    }
    thread.instructions = hideSecrets(first);
    thread.outcome = hideSecrets(last);
  }
}

/**
 * Reads the threads updated since `since` from T3's state database, read-only. Tool calls
 * belong to a message when T3 recorded its turn or run, otherwise to the thread.
 */
export function readT3(file: string, since: string, prices: Prices): T3Read {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const all: Query = (sql, ...params) => db.prepare(sql).all(...params) as Row[];
    const threads = readThreads(all, since);
    const calls = readCalls(all, since, threads, readRuns(all, since, threads, prices));
    readMessages(db, threads);
    const native = new Map<string, string>();
    for (const row of all(
      "select thread_id, payload_json from orchestration_v2_projection_provider_threads where updated_at >= ?",
      since,
    )) {
      const id = str(record(parseJson(row.payload_json).nativeThreadRef).nativeId);
      if (id && threads.has(String(row.thread_id))) native.set(id, String(row.thread_id));
    }
    return { threads, calls, native };
  } finally {
    db.close();
  }
}
