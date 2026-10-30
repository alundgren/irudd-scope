/** What one read of a computer's agent sessions returns. Facts only; nothing is stored. */

/** Token counts. Uncached input excludes cache reads and cache writes. */
export type SessionTokens = {
  uncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
};

/** One message from the person and the agent's run that answered it. */
export type SessionMessage = {
  ordinal: number;
  model: string | null;
  effort: string | null;
  fast: boolean;
  status: string;
  requestedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  tokens: SessionTokens | null;
  /** List price in US dollars, or null when the model has no known price. */
  cost: number | null;
  contextUsed: number | null;
  contextMax: number | null;
};

export type SessionThread = {
  id: string;
  title: string;
  project: string;
  parentId: string | null;
  /** `app_owned` for a thread T3 started, `provider_native` for a harness's own subagent. */
  origin: string | null;
  createdAt: string;
  messages: SessionMessage[];
  /** This thread only, including harness log tokens T3 does not record. */
  tokens: SessionTokens;
  cost: number;
  /** Models that ran in this thread, from T3 and the harness logs. */
  models: string[];
  /** The first message from the person, with secrets hidden. */
  instructions: string;
  /** The last reply from the agent, with secrets hidden. */
  outcome: string;
};

export type SessionCall = {
  threadId: string;
  /** The message whose run made the call, when T3 knows it. */
  message: number | null;
  model: string | null;
  harness: string | null;
  kind: string;
  name: string;
  /** The call's input; long inputs keep their first and last 2 KB. */
  input: string;
  status: string;
  exit: number | null;
  startedAt: string | null;
  durationMs: number | null;
  outputChars: number;
  outputHead: string;
  outputTail: string;
};

export type SessionsReply = {
  readAt: string;
  /** Threads updated since this time, with their whole tree of child threads. */
  since: string;
  days: number;
  threads: SessionThread[];
  calls: SessionCall[];
};

export const SESSION_DAYS = [1, 3, 7] as const;
export type SessionDays = (typeof SESSION_DAYS)[number];

export const emptyTokens = (): SessionTokens => ({
  uncached: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
});

export function addTokens(into: SessionTokens, from: Partial<SessionTokens>) {
  for (const key of Object.keys(into) as Array<keyof SessionTokens>) into[key] += from[key] ?? 0;
}
