import { Schema } from "effect";
import { Uuid } from "../../workspace/contract.ts";

export const LISTENING_MODEL = "google/gemini-2.5-flash-lite";
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Text = Schema.String.check(Schema.isMaxLength(1000));
export const CanvasItem = Schema.Struct({
  id: Id,
  type: Schema.String.check(Schema.isMaxLength(32)),
  text: Text,
  from: Schema.NullOr(Id),
  to: Schema.NullOr(Id),
});
export type CanvasItem = typeof CanvasItem.Type;
export const ListeningEdit = Schema.Struct({
  op: Schema.Literals(["note", "box", "connect", "rename", "remove"]),
  id: Id,
  text: Text,
  from: Schema.NullOr(Id),
  to: Schema.NullOr(Id),
});
export const ListeningReply = Schema.Struct({
  transcript: Schema.String.check(Schema.isMaxLength(4000)),
  summary: Schema.String.check(Schema.isMaxLength(4000)),
  edits: Schema.Array(ListeningEdit).check(Schema.isMaxLength(12)),
});
export type ListeningReply = typeof ListeningReply.Type;
export const ListeningRequest = Schema.Struct({
  sessionId: Uuid,
  audio: Schema.String.check(
    Schema.isMinLength(60),
    Schema.isMaxLength(600_000),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
  summary: Schema.String.check(Schema.isMaxLength(4000)),
  items: Schema.Array(CanvasItem).check(Schema.isMaxLength(150)),
});
export type ListeningRequest = typeof ListeningRequest.Type;
