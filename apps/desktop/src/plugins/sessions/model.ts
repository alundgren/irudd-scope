import {
  addTokens,
  emptyTokens,
  type SessionCall,
  type SessionThread,
  type SessionTokens,
  type SessionsReply,
} from "@irudd-scope/sessions/contract";

/** A thread with its child threads and tool calls, as shown in the tab. */
export type ThreadNode = SessionThread & {
  children: ThreadNode[];
  calls: SessionCall[];
  /** First request and last completion of this thread's own messages. */
  start: number | null;
  end: number | null;
  /** Sum of this thread's message durations. */
  agentMs: number;
};

/** Totals over a thread and every thread below it. */
export type TreeTotals = {
  cost: number;
  tokens: SessionTokens;
  calls: number;
  failed: number;
  models: string[];
  start: number | null;
  end: number | null;
  agentMs: number;
  threads: number;
};

export type SessionsModel = {
  roots: ThreadNode[];
  byId: Map<string, ThreadNode>;
  projects: string[];
};

const time = (value: string | null) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

export function buildModel(reply: SessionsReply): SessionsModel {
  const byId = new Map<string, ThreadNode>();
  for (const thread of reply.threads) {
    const starts = thread.messages.map((m) => time(m.requestedAt)).filter((t) => t !== null);
    const ends = thread.messages.map((m) => time(m.completedAt)).filter((t) => t !== null);
    byId.set(thread.id, {
      ...thread,
      children: [],
      calls: [],
      start: starts.length ? Math.min(...starts) : time(thread.createdAt),
      end: ends.length ? Math.max(...ends) : null,
      agentMs: thread.messages.reduce((sum, m) => sum + (m.durationMs ?? 0), 0),
    });
  }
  for (const call of reply.calls) byId.get(call.threadId)?.calls.push(call);
  const roots: ThreadNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const newest = (a: ThreadNode, b: ThreadNode) => (b.start ?? 0) - (a.start ?? 0);
  const oldest = (a: ThreadNode, b: ThreadNode) => (a.start ?? 0) - (b.start ?? 0);
  roots.sort(newest);
  for (const node of byId.values()) node.children.sort(oldest);
  const projects = [...new Set(roots.map((node) => node.project))].sort((a, b) =>
    a.localeCompare(b),
  );
  return { roots, byId, projects };
}

export function totals(node: ThreadNode): TreeTotals {
  const sum: TreeTotals = {
    cost: 0,
    tokens: emptyTokens(),
    calls: 0,
    failed: 0,
    models: [],
    start: null,
    end: null,
    agentMs: 0,
    threads: 0,
  };
  for (const thread of descendants(node)) {
    sum.cost += thread.cost;
    addTokens(sum.tokens, thread.tokens);
    sum.calls += thread.calls.length;
    sum.failed += thread.calls.filter((call) => call.status !== "completed").length;
    for (const model of thread.models) if (!sum.models.includes(model)) sum.models.push(model);
    if (thread.start !== null) sum.start = Math.min(sum.start ?? thread.start, thread.start);
    if (thread.end !== null) sum.end = Math.max(sum.end ?? thread.end, thread.end);
    sum.agentMs += thread.agentMs;
    sum.threads += 1;
  }
  return sum;
}

/** The thread and every thread below it. */
export function descendants(node: ThreadNode): ThreadNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

export function ancestors(node: ThreadNode, byId: Map<string, ThreadNode>): ThreadNode[] {
  const path: ThreadNode[] = [];
  for (let at = node.parentId ? byId.get(node.parentId) : undefined; at;) {
    path.unshift(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path;
}

export const TOKEN_KINDS: Array<[keyof SessionTokens, string, string]> = [
  ["uncached", "Input (not cached)", "uncached"],
  ["cacheRead", "Cache read", "read"],
  ["cacheWrite5m", "Cache write 5 min", "write5m"],
  ["cacheWrite1h", "Cache write 1 h", "write1h"],
  ["output", "Output", "output"],
];

export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const usd = (n: number) => `$${n.toFixed(2)}`;
export function duration(ms: number | null) {
  if (ms === null) return "–";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}
/** A weekday and a 24-hour time, such as Tue 19:03. */
export const when = (at: number | null) =>
  at === null
    ? "–"
    : new Date(at).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-fable-5-1": "Fable 5.1",
};
/** Claude models get their family name; other models keep their id. */
export const modelName = (model: string | null) =>
  model ? (MODEL_NAMES[model.split("[")[0]!] ?? model) : "Unknown model";
