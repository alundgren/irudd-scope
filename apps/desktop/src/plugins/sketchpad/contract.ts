import { Schema } from "effect";

export const SketchpadTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({}),
});
export const sketchpadTabContract = {
  type: "sketchpad",
  category: "builtin" as const,
  version: 1,
  state: SketchpadTabState,
};
export const sketchpadTabState = () => ({ version: 1, data: {} });

export const MAX_SKETCHPAD_BYTES = 32 * 1024 * 1024;
const Viewport = Schema.Struct({
  zoom: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 30 })),
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
});
export type SketchpadViewport = typeof Viewport.Type;
// Content is Excalidraw's local serialization, which omits deleted elements and unused images.
export const SketchpadDraft = Schema.Struct({
  version: Schema.Literal(1),
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SKETCHPAD_BYTES)),
  viewport: Schema.optionalKey(Viewport),
});
export type SketchpadDraft = typeof SketchpadDraft.Type;
