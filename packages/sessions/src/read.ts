import { existsSync } from "node:fs";
import { join } from "node:path";
import { addTokens, type SessionDays, type SessionsReply } from "./contract.ts";
import { readLogs } from "./logs.ts";
import { readPrices } from "./prices.ts";
import { readT3 } from "./t3.ts";

export class SessionsReadError extends Error {}

/**
 * Reads this computer's T3 threads updated in the last `days`, with the Claude Code and Codex
 * logs behind them. Nothing is written.
 */
export async function readSessions(options: {
  home: string;
  days: SessionDays;
  now?: Date;
}): Promise<SessionsReply> {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.days * 86_400_000;
  const since = new Date(cutoff).toISOString();
  const folder = join(options.home, ".t3", "userdata");
  const database = join(folder, "statev2.sqlite");
  if (!existsSync(database))
    throw new SessionsReadError("T3 Code's history was not found on this computer.");
  const prices = await readPrices(join(folder, "usage-model-rates.json"));
  let t3: ReturnType<typeof readT3>;
  try {
    t3 = readT3(database, since, prices);
  } catch {
    throw new SessionsReadError("Scope could not read T3 Code's history.");
  }
  const { threads, calls, native } = t3;

  const counted = new Map<string, number>();
  for (const call of calls) counted.set(call.threadId, (counted.get(call.threadId) ?? 0) + 1);
  // T3 names a Claude Code subagent's thread `thread:provider:…:<agent id>`.
  const byAgent = new Map<string, string>();
  for (const id of threads.keys())
    if (id.startsWith("thread:provider:"))
      byAgent.set(decodeURIComponent(id).split(":").at(-1)!, id);

  for (const log of await readLogs(options.home, cutoff, new Set(native.keys()))) {
    const child = log.agent ? byAgent.get(log.agent) : undefined;
    const threadId = child ?? native.get(log.session);
    const thread = threadId ? threads.get(threadId) : undefined;
    if (!thread) continue;
    const t3Tokens = thread.messages.some((message) => message.tokens);
    // T3 records no tokens for Claude Code's own subagents; for other threads it does.
    const ownTokens = (log.harness === "claude" && log.subagent) || !t3Tokens;
    for (const [model, tokens] of log.models) {
      // Claude Code logs `<synthetic>` for messages no model wrote.
      if (!/^(\?|<.*>)$/.test(model) && !thread.models.includes(model)) thread.models.push(model);
      if (!ownTokens) continue;
      addTokens(thread.tokens, tokens);
      thread.cost += prices(model, tokens) ?? 0;
    }
    // A subagent without its own T3 thread falls back to its parent's thread, whose T3 calls
    // are the parent's. Otherwise the log repeats calls T3 already has.
    const unlinkedSubagent = log.subagent && log.harness === "claude" && !child;
    if (unlinkedSubagent || !counted.get(thread.id))
      for (const call of log.calls) calls.push({ ...call, threadId: thread.id, message: null });
  }

  // Calls in threads without a T3 run take the model the thread's log names.
  for (const call of calls) call.model ??= threads.get(call.threadId)?.models[0] ?? null;
  return {
    readAt: now.toISOString(),
    since,
    days: options.days,
    threads: [...threads.values()],
    calls,
  };
}
