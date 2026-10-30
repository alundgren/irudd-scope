import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { addTokens, emptyTokens, type SessionCall, type SessionTokens } from "./contract.ts";
import { between, inputText, num, outputFields, parseJson, record, str, toolName } from "./text.ts";

/** One harness log file: tokens per model and its tool calls, before linking to a thread. */
export type HarnessLog = {
  harness: "claude" | "codex";
  session: string;
  /** A Claude subagent's agent id, from `agent-<id>.jsonl`. */
  agent: string | null;
  subagent: boolean;
  models: Map<string, SessionTokens>;
  calls: Array<Omit<SessionCall, "threadId" | "message">>;
};

/** `.jsonl` files below `folder` changed since `since`. Links are never followed. */
async function logFiles(folder: string, since: number): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string, depth: number) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && depth < 6) await visit(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await lstat(child).catch(() => null);
        if (info?.isFile() && info.mtimeMs >= since) found.push(child);
      }
    }
  };
  await visit(folder, 0);
  return found;
}

async function* lines(file: string) {
  const reader = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      const value = parseJson(line);
      if (Object.keys(value).length) yield value;
    }
  } finally {
    reader.close();
  }
}

function addModel(log: HarnessLog, model: string, tokens: SessionTokens) {
  const total = log.models.get(model) ?? emptyTokens();
  addTokens(total, tokens);
  log.models.set(model, total);
}

async function claudeLog(file: string): Promise<HarnessLog> {
  const parts = file.split(/[\\/]/);
  const subagent = parts.at(-2) === "subagents";
  const log: HarnessLog = {
    harness: "claude",
    session: subagent ? parts.at(-3)! : basename(file, ".jsonl"),
    agent: subagent ? basename(file, ".jsonl").replace(/^agent-/, "") : null,
    subagent,
    models: new Map(),
    calls: [],
  };
  // Claude Code writes one line per content block; usage repeats under the same message id.
  const seen = new Set<string>();
  const pending = new Map<
    string,
    { name: string; at: string | null; input: unknown; model: string | null }
  >();
  for await (const line of lines(file)) {
    const at = str(line.timestamp);
    const message = record(line.message);
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    if (line.type === "assistant") {
      const id = str(message.id);
      const usage = record(message.usage);
      if (id && !seen.has(id) && Object.keys(usage).length) {
        seen.add(id);
        const cache = record(usage.cache_creation);
        const hour = num(cache.ephemeral_1h_input_tokens);
        addModel(log, str(message.model) ?? "?", {
          uncached: num(usage.input_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite5m:
            "ephemeral_5m_input_tokens" in cache
              ? num(cache.ephemeral_5m_input_tokens)
              : num(usage.cache_creation_input_tokens) - hour,
          cacheWrite1h: hour,
          output: num(usage.output_tokens),
          reasoning: num(record(usage.output_tokens_details).thinking_tokens),
        });
      }
      for (const block of content)
        if (block.type === "tool_use" && typeof block.id === "string")
          pending.set(block.id, {
            name: str(block.name) ?? "?",
            at,
            input: block.input,
            model: str(message.model),
          });
    } else if (line.type === "user") {
      for (const block of content) {
        const call = typeof block.tool_use_id === "string" && pending.get(block.tool_use_id);
        if (!call) continue;
        pending.delete(block.tool_use_id as string);
        log.calls.push({
          model: call.model,
          harness: "claude",
          kind: "tool",
          name: toolName(call.name),
          input: inputText(call.input),
          status: block.is_error === true ? "failed" : "completed",
          exit: null,
          startedAt: call.at,
          durationMs: between(call.at, at),
          ...outputFields(block.content),
        });
      }
    }
  }
  return log;
}

async function codexLog(file: string): Promise<HarnessLog> {
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
    file,
  )?.[1];
  const log: HarnessLog = {
    harness: "codex",
    session: id ?? basename(file, ".jsonl"),
    agent: null,
    subagent: false,
    models: new Map(),
    calls: [],
  };
  const seen = new Set<string>();
  const pending = new Map<string, { name: string; at: string | null; input: unknown }>();
  let model: string | null = null;
  for await (const line of lines(file)) {
    const at = str(line.timestamp);
    const payload = record(line.payload);
    if (line.type === "session_meta") {
      if (payload.source && typeof payload.source === "object") log.subagent = true;
    } else if (line.type === "turn_context") model = str(payload.model) ?? model;
    else if (line.type === "token_usage_record") {
      const response = str(payload.response_id) ?? "";
      if (seen.has(response)) continue;
      seen.add(response);
      const usage = record(payload.usage);
      const input = num(usage.input_tokens);
      const read = num(usage.cached_input_tokens);
      const write = num(usage.cache_write_input_tokens);
      addModel(log, model ?? "?", {
        uncached: Math.max(input - read - write, 0),
        cacheRead: read,
        cacheWrite5m: write,
        cacheWrite1h: 0,
        output: num(usage.output_tokens),
        reasoning: num(usage.reasoning_output_tokens),
      });
    } else if (line.type === "response_item") {
      const call = str(payload.call_id);
      if (!call) continue;
      if (payload.type === "function_call" || payload.type === "custom_tool_call")
        pending.set(call, {
          name: str(payload.name) ?? "?",
          at,
          input: payload.arguments ?? payload.input,
        });
      else if (
        (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") &&
        pending.has(call)
      ) {
        const started = pending.get(call)!;
        pending.delete(call);
        log.calls.push({
          model,
          harness: "codex",
          kind: "tool",
          name: toolName(started.name),
          input: inputText(started.input),
          status: "completed",
          exit: null,
          startedAt: started.at,
          durationMs: between(started.at, at),
          ...outputFields(payload.output),
        });
      }
    }
  }
  return log;
}

/** Claude Code and Codex logs changed since `since`, for the sessions T3 knows. */
export async function readLogs(home: string, since: number, known: Set<string>) {
  const [claude, codex] = await Promise.all([
    logFiles(join(home, ".claude", "projects"), since),
    logFiles(join(home, ".codex", "sessions"), since),
  ]);
  const logs: HarnessLog[] = [];
  for (const file of claude) {
    const parts = file.split(/[\\/]/);
    const session = parts.at(-2) === "subagents" ? parts.at(-3)! : basename(file, ".jsonl");
    if (known.has(session)) logs.push(await claudeLog(file));
  }
  for (const file of codex) {
    const id = /([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1];
    if (id && known.has(id)) logs.push(await codexLog(file));
  }
  return logs;
}
