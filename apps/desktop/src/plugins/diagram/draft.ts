import { Schema } from "effect";
import { Revision } from "@irudd-scope/protocol";

export const DiagramDraft = Schema.Struct({
  version: Schema.Literal(1),
  content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  revision: Revision,
  dirty: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      details: Schema.optionalKey(Schema.String),
    }),
  ),
  intent: Schema.String.check(Schema.isMaxLength(16_000)),
  chatOpen: Schema.Boolean,
  viewport: Schema.Struct({
    zoom: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 30 })),
    scrollX: Schema.Finite,
    scrollY: Schema.Finite,
  }),
});
export type DiagramDraft = typeof DiagramDraft.Type;
