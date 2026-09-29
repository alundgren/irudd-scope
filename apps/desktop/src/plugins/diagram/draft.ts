import { Schema } from "effect";
import { Revision } from "@irudd-scope/protocol";
import { DiagramProposal } from "@irudd-scope/protocol/diagram-sync";

const Viewport = Schema.Struct({
  zoom: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 30 })),
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
});
export type DiagramViewport = typeof Viewport.Type;

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
      agent: Schema.optionalKey(Schema.Literals(["external", "embedded"])),
    }),
  ),
  intent: Schema.String.check(Schema.isMaxLength(16_000)),
  chatOpen: Schema.Boolean,
  proposal: Schema.optionalKey(DiagramProposal),
  proposalViewport: Schema.optionalKey(Viewport),
  conversationTarget: Schema.optionalKey(Schema.Literals(["external", "embedded"])),
  viewport: Schema.optionalKey(Viewport),
});
export type DiagramDraft = typeof DiagramDraft.Type;
