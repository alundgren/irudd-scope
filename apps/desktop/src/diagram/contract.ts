import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";

const id = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const label = Schema.String.check(Schema.isMaxLength(500));
const coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 }));
const size = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3000 }));
const kind = Schema.Literals(["rectangle", "ellipse", "diamond"]);
const style = Schema.Literals(["solid", "dashed"]);
export const OperationSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("createNode"),
    id,
    kind,
    label,
    x: coordinate,
    y: coordinate,
    width: Schema.NullOr(size),
    height: Schema.NullOr(size),
  }),
  Schema.Struct({
    type: Schema.Literal("createText"),
    id,
    text: label,
    x: coordinate,
    y: coordinate,
  }),
  Schema.Struct({
    type: Schema.Literal("connect"),
    id,
    from: id,
    to: id,
    label: Schema.NullOr(label),
    style: Schema.NullOr(style),
  }),
  Schema.Struct({ type: Schema.Literal("move"), id, x: coordinate, y: coordinate }),
  Schema.Struct({ type: Schema.Literal("resize"), id, width: size, height: size }),
  Schema.Struct({ type: Schema.Literal("setLabel"), id, label }),
  Schema.Struct({
    type: Schema.Literal("delete"),
    ids: Schema.Array(id).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literal("group"),
    id,
    label,
    ids: Schema.Array(id).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
]);
export const DrawingResponse = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(2000)),
  operations: Schema.Array(OperationSchema).check(Schema.isMaxLength(100)),
});
export const SceneSchema = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ id, kind, label, x: coordinate, y: coordinate, width: size, height: size }),
  ).check(Schema.isMaxLength(150)),
  texts: Schema.Array(Schema.Struct({ id, text: label, x: coordinate, y: coordinate })).check(
    Schema.isMaxLength(100),
  ),
  connections: Schema.Array(Schema.Struct({ id, from: id, to: id, label, style })).check(
    Schema.isMaxLength(300),
  ),
  groups: Schema.Array(
    Schema.Struct({
      id,
      label,
      ids: Schema.Array(id).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    }),
  ).check(Schema.isMaxLength(30)),
});
// Operation batches mutate a private copy, then validate it before committing.
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
export type SemanticScene = Mutable<typeof SceneSchema.Type>;
export type SceneNode = SemanticScene["nodes"][number];
export type DrawingOperation = typeof OperationSchema.Type;
export function parseScene(input: unknown): SemanticScene {
  return structuredClone(decode(SceneSchema, input)) as SemanticScene;
}
export function emptyScene(): SemanticScene {
  return { nodes: [], texts: [], connections: [], groups: [] };
}
export const DiagramRequest = Schema.Struct({
  intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
  scene: SceneSchema,
});
export type DiagramRequest = typeof DiagramRequest.Type;
export type DrawingResult = typeof DrawingResponse.Type & {
  metrics: {
    model: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  };
};
export interface DiagramProvider {
  compose: (request: DiagramRequest, signal: AbortSignal) => Promise<DrawingResult>;
}
