import { Schema } from "effect";
import {
  HarnessId,
  HarnessMachine,
  type HarnessScan,
  type HarnessesReply,
} from "@irudd-scope/protocol/harnesses";

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
  /** Folder sizes are being counted. Pending sizes finish only while this or `scanning` is true. */
  counting: boolean;
};

/**
 * One machine column. The first column is this computer; the others are compared with it.
 * Remote and guest columns add their own name and connection status.
 */
export type MachineColumn = {
  machine: HarnessMachine;
  label: string;
  scan: HarnessScan | null;
};

/** One harness, or the shared skill folder, on one machine. */
export const HarnessJsonRequest = Schema.Struct({
  machine: HarnessMachine,
  harness: Schema.Union([HarnessId, Schema.Literal("shared")]),
});
export type HarnessJsonRequest = typeof HarnessJsonRequest.Type;
