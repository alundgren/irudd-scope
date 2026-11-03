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
  "wireframe",
  "state",
  "er",
  "board",
  "bars",
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

export const SECTION_SIZES = ["s", "m", "l"] as const;
export const MAX_SECTIONS = 40;
export const MAX_SECTION_BLOCKS = 8;
export const SectionSize = Schema.Literals(SECTION_SIZES);
export type SectionSize = typeof SectionSize.Type;
export const Section = Schema.Struct({
  id: BlockId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  size: SectionSize,
  /** Set once a person drags the section; unpinned sections flow in creation order. */
  pinned: Schema.Boolean,
  x: Schema.Finite,
  y: Schema.Finite,
  blocks: Schema.Array(Block).check(Schema.isMaxLength(MAX_SECTION_BLOCKS)),
});
export type Section = typeof Section.Type;
export const Canvas = Schema.Struct({
  version: Schema.Literal(2),
  title: Schema.String.check(Schema.isMaxLength(160)),
  sections: Schema.Array(Section).check(Schema.isMaxLength(MAX_SECTIONS)),
});
export type Canvas = typeof Canvas.Type;

export const MeetingTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    canvas: Schema.optionalKey(Canvas),
    /** Saved by the first test build; loaded once as a single section. */
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

/** One block change inside a section, as `page.ts` applies it; unused fields are null. */
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
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });

export const CANVAS_OPS = [
  "create_section",
  "rename_section",
  "remove_section",
  "resize_section",
  "add",
  "replace",
  "patch",
  "remove",
] as const;
/**
 * One canvas change. Every field is present for strict structured output; unused fields
 * are null. `section` names the target by id or name; null means the section created
 * earlier in the same reply, otherwise the focused section.
 */
export const CanvasOp = Schema.Struct({
  op: Schema.Literals(CANVAS_OPS),
  section: Schema.NullOr(Schema.String),
  id: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(BlockKind),
  width: Schema.NullOr(BlockWidth),
  after: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  find: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  size: Schema.NullOr(SectionSize),
});
export type CanvasOp = typeof CanvasOp.Type;
export const CanvasReply = Schema.Struct({
  ops: Schema.Array(CanvasOp).check(Schema.isMaxLength(MAX_OPS)),
});
export type CanvasReply = typeof CanvasReply.Type;
export const CANVAS_REPLY_JSON_SCHEMA = {
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
        required: [
          "op",
          "section",
          "id",
          "kind",
          "width",
          "after",
          "source",
          "find",
          "text",
          "name",
          "size",
        ],
        properties: {
          op: { type: "string", enum: [...CANVAS_OPS] },
          section: nullable({ type: "string" }),
          id: nullable({ type: "string" }),
          kind: nullable({ type: "string", enum: [...BLOCK_KINDS] }),
          width: nullable({ type: "string", enum: [...BLOCK_WIDTHS] }),
          after: nullable({ type: "string" }),
          source: nullable({ type: "string" }),
          find: nullable({ type: "string" }),
          text: nullable({ type: "string" }),
          name: nullable({ type: "string" }),
          size: nullable({ type: "string", enum: [...SECTION_SIZES] }),
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
  canvas: Canvas,
  /** What was asked after the wake word, or typed into Ask the canvas. */
  request: Line,
  /** Transcript just before the request, so "draw what Sam described" can resolve. */
  recent: Schema.Array(Line).check(Schema.isMaxLength(30)),
  /** Id of the section changed last, for requests like "make that one vertical". */
  focus: Schema.NullOr(Schema.String),
  settings: MeetingSettings,
  /** How the wake detector ended a spoken request, for the debug log. Absent when typed. */
  closedBy: Schema.optionalKey(
    Schema.Literals(["pause", "sentence", "chunks", "wake", "quiet", "fallback"]),
  ),
});
export type EditRequest = typeof EditRequest.Type;
export const EditResult = Schema.Struct({
  ops: Schema.Array(CanvasOp),
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
