import { Schema } from "effect";
import { Uuid } from "../../workspace/contract.ts";

export const CANVAS_TAB_TYPE = "canvas";

/** Card and record IDs. Main makes them; they are unique across scope.db and never reused. */
export const CanvasId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{8}$/));
/** A name for a record that a change creates, such as `$cache`. Main replaces it with a new ID. */
export const CanvasRef = Schema.String.check(Schema.isPattern(/^\$[A-Za-z0-9_-]{1,32}$/));
const OpId = Schema.Union([CanvasId, CanvasRef]);

export const MAX_BOARD_CARDS = 1000;
export const MAX_CARD_RECORDS = 5000;
export const MAX_CARD_BYTES = 2 * 1024 * 1024;
export const MAX_HISTORY_ENTRIES = 500;
export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_CHANGE_OPS = 2000;

const Coordinate = Schema.Int.check(
  Schema.isBetween({ minimum: -10_000_000, maximum: 10_000_000 }),
);
export const CARD_SIZE = { min: 80, max: 100_000 } as const;
const Length = Schema.Int.check(
  Schema.isBetween({ minimum: CARD_SIZE.min, maximum: CARD_SIZE.max }),
);
/** Fractional index strings order cards and records without renumbering their neighbours. */
export const OrderKey = Schema.String.check(Schema.isPattern(/^[0-9A-Za-z]{1,128}$/));
export const CardTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const CardTypeName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));

/** Where a card sits on the board. Its content lives in its own row. */
export const BoardCard = Schema.Struct({
  type: CardTypeName,
  title: CardTitle,
  x: Coordinate,
  y: Coordinate,
  w: Length,
  h: Length,
  z: OrderKey,
});
export type BoardCard = typeof BoardCard.Type;
export const BOARD_FIELDS = ["title", "x", "y", "w", "h", "z"] as const;

const Camera = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  zoom: Schema.Finite.check(Schema.isBetween({ minimum: 0.05, maximum: 8 })),
});
export type CanvasCamera = typeof Camera.Type;
export const CanvasTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    camera: Schema.optionalKey(Camera),
    /** The card whose editor fills the tab. */
    open: Schema.optionalKey(CanvasId),
    /** Each card editor's own pan and zoom. */
    cameras: Schema.optionalKey(Schema.Record(CanvasId, Camera)),
  }),
});
export type CanvasTabState = typeof CanvasTabState.Type;
export const canvasTabContract = {
  type: CANVAS_TAB_TYPE,
  version: 1,
  state: CanvasTabState,
  permanentOnCreate: true as const,
};
export const canvasTabState = (): CanvasTabState => ({ version: 1, data: {} });

const RecordValue = Schema.Record(Schema.String, Schema.Json);
/**
 * `put` adds or replaces a whole record, `set` changes named fields, and `del` removes a record.
 * A field set to null is removed, so a field equal to its default can be left out.
 */
export const CanvasOp = Schema.Union([
  Schema.Struct({ op: Schema.Literal("put"), id: OpId, value: RecordValue }),
  Schema.Struct({ op: Schema.Literal("set"), id: OpId, fields: RecordValue }),
  Schema.Struct({ op: Schema.Literal("del"), id: OpId }),
]);
export type CanvasOp = typeof CanvasOp.Type;
export const CanvasTarget = Schema.Union([
  Schema.Struct({ board: Schema.Literal(true) }),
  Schema.Struct({ card: CanvasId }),
]);
export type CanvasTarget = typeof CanvasTarget.Type;
export const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/));
export const ChangeLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));

/** One gesture or one agent tool call against one target, made from the version the writer read. */
export const CanvasChange = Schema.Struct({
  tabId: Uuid,
  requestId: RequestId,
  target: CanvasTarget,
  base: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  label: ChangeLabel,
  ops: Schema.Array(CanvasOp).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHANGE_OPS)),
});
export type CanvasChange = typeof CanvasChange.Type;
export const CanvasStep = Schema.Struct({
  tabId: Uuid,
  requestId: RequestId,
  target: CanvasTarget,
  direction: Schema.Literals(["undo", "redo"]),
});
export type CanvasStep = typeof CanvasStep.Type;
export const CanvasIdRequest = Schema.Struct({
  tabId: Uuid,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
});

export type CanvasActor = "person" | "agent";
/** A field an undo left alone because someone changed it after the undone step. */
export type KeptField = { id: string; field?: string };
export type CanvasWritten = {
  ok: true;
  version: number;
  /** New IDs for the `$` names in the change. */
  refs: Record<string, string>;
  /** Newer versions this change was applied over because it touched none of their fields. */
  replayedOver: number[];
  kept: KeptField[];
  label: string;
};
export type CanvasRefused = {
  ok: false;
  code: "conflict" | "invalid" | "stale" | "missing" | "empty";
  message: string;
};
export type CanvasWriteResult = CanvasWritten | CanvasRefused;

export type CardContent = Record<string, Record<string, unknown>>;
export type CanvasCardRow = {
  type: string;
  typeVersion: number;
  version: number;
  content: CardContent;
};
export type CanvasHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
};
export type CanvasSnapshot = {
  board: { version: number; cards: Record<string, BoardCard> };
  cards: Record<string, CanvasCardRow>;
  history: Record<string, CanvasHistoryState>;
};
/** Sent to the open view after main commits a change, so agent edits and undo appear at once. */
export type CanvasChanged = {
  tabId: string;
  target: CanvasTarget;
  version: number;
  actor: CanvasActor;
};

export const targetScope = (target: CanvasTarget) => ("board" in target ? "" : target.card);
