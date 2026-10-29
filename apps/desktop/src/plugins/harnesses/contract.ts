import { Schema } from "effect";
import { HarnessId, HarnessMachine, type HarnessesReply } from "@irudd-scope/protocol/harnesses";

export const HarnessesTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({}),
});
export const harnessesTabContract = {
  type: "harnesses",
  category: "builtin" as const,
  version: 1,
  state: HarnessesTabState,
};
export const harnessesTabState = () => ({ version: 1, data: {} });

/** What the tab shows: the latest scans, whether a scan runs, and why the last one failed. */
export type HarnessesState = {
  reply: HarnessesReply;
  scanning: boolean;
  /** A fixed message without file contents or paths, or null after a successful scan. */
  error: string | null;
  /** Counting folder sizes failed, so sizes still marked pending will not finish. */
  countFailed: boolean;
};

/** One harness, or the shared skill folder, on one machine. */
export const HarnessJsonRequest = Schema.Struct({
  machine: HarnessMachine,
  harness: Schema.Union([HarnessId, Schema.Literal("shared")]),
});
export type HarnessJsonRequest = typeof HarnessJsonRequest.Type;
