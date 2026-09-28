import { Schema } from "effect";
import { Artifact, ArtifactId, ArtifactName, Revision, Source, decode } from "./index.ts";

export const DiagramObjectId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const id = DiagramObjectId;
const newId = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const label = Schema.String.check(Schema.isMaxLength(500));
const coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }),
);
const size = Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));
const kind = Schema.Literals(["rectangle", "ellipse", "diamond"]);
const style = Schema.Literals(["solid", "dashed"]);
export const DiagramOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("createNode"),
    id: newId,
    kind,
    label,
    x: coordinate,
    y: coordinate,
    width: Schema.NullOr(size),
    height: Schema.NullOr(size),
  }),
  Schema.Struct({
    type: Schema.Literal("createText"),
    id: newId,
    text: label,
    x: coordinate,
    y: coordinate,
  }),
  Schema.Struct({
    type: Schema.Literal("connect"),
    id: newId,
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
export const DiagramOperations = Schema.Array(DiagramOperation).check(Schema.isMaxLength(100));
export const SceneSchema = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({ id, kind, label, x: coordinate, y: coordinate, width: size, height: size }),
  ).check(Schema.isMaxLength(500)),
  texts: Schema.Array(Schema.Struct({ id, text: label, x: coordinate, y: coordinate })).check(
    Schema.isMaxLength(100),
  ),
  connections: Schema.Array(Schema.Struct({ id, from: id, to: id, label, style })).check(
    Schema.isMaxLength(1000),
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
export type DiagramOperation = typeof DiagramOperation.Type;
export function parseScene(input: unknown): SemanticScene {
  return structuredClone(decode(SceneSchema, input)) as SemanticScene;
}
export function emptyScene(): SemanticScene {
  return { nodes: [], texts: [], connections: [], groups: [] };
}

export const ReadOnlyDiagramObject = Schema.Struct({
  id,
  type: Schema.String.check(Schema.isMaxLength(80)),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  text: Schema.String.check(Schema.isMaxLength(500)),
  reason: Schema.String.check(Schema.isMaxLength(200)),
});
export const DiagramContext = Schema.Struct({
  scene: SceneSchema,
  selectedIds: Schema.Array(id).check(Schema.isMaxLength(1000)),
  readOnly: Schema.Array(ReadOnlyDiagramObject).check(Schema.isMaxLength(1000)),
  omitted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DiagramContext = typeof DiagramContext.Type;
export const DiagramSnapshotId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const DiagramSnapshot = Schema.Struct({
  id: ArtifactId,
  revision: Revision,
  snapshot: DiagramSnapshotId,
  dirty: Schema.Boolean,
  ...DiagramContext.fields,
});
export type DiagramSnapshot = typeof DiagramSnapshot.Type;
export const DiagramCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read"), id: ArtifactId }),
  Schema.Struct({
    action: Schema.Literal("create"),
    name: Schema.optionalKey(ArtifactName),
    id: ArtifactId,
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
    operations: DiagramOperations,
    source: Schema.optionalKey(Source),
  }),
  Schema.Struct({
    action: Schema.Literal("apply"),
    id: ArtifactId,
    snapshot: DiagramSnapshotId,
    operations: DiagramOperations,
  }),
  Schema.Struct({
    action: Schema.Literal("preview"),
    id: ArtifactId,
    snapshot: Schema.optionalKey(DiagramSnapshotId),
  }),
]);
export type DiagramCommand = typeof DiagramCommand.Type;
export const DiagramReply = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), diagram: DiagramSnapshot }),
  Schema.Struct({ type: Schema.Literal("created"), artifact: Artifact }),
  Schema.Struct({
    type: Schema.Literal("preview"),
    id: ArtifactId,
    revision: Revision,
    snapshot: DiagramSnapshotId,
    mediaType: Schema.Literal("image/png"),
    data: Schema.String.check(Schema.isMaxLength(12 * 1024 * 1024)),
  }),
]);
export type DiagramReply = typeof DiagramReply.Type;
export const MAX_DIAGRAM_REQUEST_BYTES = 512 * 1024;
export const MAX_DIAGRAM_REPLY_BYTES = 16 * 1024 * 1024;
