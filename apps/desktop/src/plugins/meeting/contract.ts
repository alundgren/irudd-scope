import { Schema } from "effect";

export const BLOCK_KINDS = ["text", "diagram", "note", "decision", "risk", "question"] as const;
export const BLOCK_WIDTHS = ["full", "half", "third"] as const;
export const DIAGRAM_KINDS = [
  "flow",
  "sequence",
  "steps",
  "timeline",
  "checklist",
  "compare",
  "metrics",
  "tree",
] as const;
export const MAX_BLOCKS = 60;
export const MAX_SOURCE = 6_000;
export const MAX_OPS = 12;

export const BlockId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);
export const BlockKind = Schema.Literals(BLOCK_KINDS);
export type BlockKind = typeof BlockKind.Type;
export const BlockWidth = Schema.Literals(BLOCK_WIDTHS);
export type BlockWidth = typeof BlockWidth.Type;

export const Block = Schema.Struct({
  id: BlockId,
  kind: BlockKind,
  width: BlockWidth,
  source: Schema.String.check(Schema.isMaxLength(MAX_SOURCE)),
});
export type Block = typeof Block.Type;

export const Page = Schema.Struct({
  version: Schema.Literal(1),
  title: Schema.String.check(Schema.isMaxLength(160)),
  blocks: Schema.Array(Block).check(Schema.isMaxLength(MAX_BLOCKS)),
});
export type Page = typeof Page.Type;

export const OPENROUTER_EDIT_MODELS = [
  "openai/gpt-6.1-terra",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6-luna",
  "google/gemini-4-argon",
] as const;
export const CODEX_MODEL = "gpt-6.1-terra";
export const CODEX_EFFORT = "medium";
export const CODEX_SERVICE_TIER = "priority";
export const TRANSCRIPTION_MODEL = "mistralai/voxtral-mini-transcribe-3-0";

export const MeetingSettings = Schema.Struct({
  backend: Schema.Literals(["openrouter", "codex"]),
  openrouterModel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  /** ISO-639-1 code, or empty for automatic detection. */
  language: Schema.String.check(Schema.isMaxLength(8)),
  /** Absolute path to the codex binary, used only when automatic lookup fails. */
  codexPath: Schema.String.check(Schema.isMaxLength(1024)),
});
export type MeetingSettings = typeof MeetingSettings.Type;

export const MeetingTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    page: Schema.optionalKey(Page),
    settings: Schema.optionalKey(MeetingSettings),
  }),
});
export const meetingTabContract = {
  type: "meeting",
  category: "builtin" as const,
  version: 1,
  state: MeetingTabState,
};
export const meetingTabState = () => ({ version: 1, data: {} });
export const defaultMeetingSettings = (): MeetingSettings => ({
  backend: "codex",
  openrouterModel: OPENROUTER_EDIT_MODELS[0],
  language: "",
  codexPath: "",
});

/**
 * One page change. Every field is present so the reply works with strict structured
 * output, which requires all properties; fields an op does not use are null.
 */
export const EditOp = Schema.Struct({
  op: Schema.Literals(["add", "replace", "patch", "move", "remove", "title"]),
  id: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(BlockKind),
  width: Schema.NullOr(BlockWidth),
  after: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  find: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
});
export type EditOp = typeof EditOp.Type;
export const EditReply = Schema.Struct({
  ops: Schema.Array(EditOp).check(Schema.isMaxLength(MAX_OPS)),
});
export type EditReply = typeof EditReply.Type;

const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
/** The JSON Schema both edit backends receive, written out so providers see plain keywords. */
export const EDIT_REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ops"],
  properties: {
    ops: {
      type: "array",
      maxItems: MAX_OPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "id", "kind", "width", "after", "source", "find", "text"],
        properties: {
          op: { type: "string", enum: ["add", "replace", "patch", "move", "remove", "title"] },
          id: nullable({ type: "string" }),
          kind: nullable({ type: "string", enum: [...BLOCK_KINDS] }),
          width: nullable({ type: "string", enum: [...BLOCK_WIDTHS] }),
          after: nullable({ type: "string" }),
          source: nullable({ type: "string" }),
          find: nullable({ type: "string" }),
          text: nullable({ type: "string" }),
        },
      },
    },
  },
} as const;

export const TranscribeRequest = Schema.Struct({
  audio: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000_000)),
  language: Schema.String.check(Schema.isMaxLength(8)),
});
export type TranscribeRequest = typeof TranscribeRequest.Type;
export const TranscribeResult = Schema.Struct({
  text: Schema.String,
  ms: Schema.Number,
  model: Schema.String,
});
export type TranscribeResult = typeof TranscribeResult.Type;

const Line = Schema.String.check(Schema.isMaxLength(4_000));
export const EditRequest = Schema.Struct({
  page: Page,
  /** Earlier transcript lines, for context only. */
  context: Schema.Array(Line).check(Schema.isMaxLength(60)),
  /** Transcript lines the model has not seen yet. */
  fresh: Schema.Array(Line).check(Schema.isMaxLength(60)),
  /** A typed request from the presenter, which the model must carry out. */
  request: Schema.NullOr(Line),
  settings: MeetingSettings,
});
export type EditRequest = typeof EditRequest.Type;
export const EditResult = Schema.Struct({
  ops: Schema.Array(EditOp),
  ms: Schema.Number,
  backend: Schema.Literals(["openrouter", "codex"]),
  model: Schema.String,
});
export type EditResult = typeof EditResult.Type;

export const ExportRequest = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000_000)),
});
export type ExportRequest = typeof ExportRequest.Type;
