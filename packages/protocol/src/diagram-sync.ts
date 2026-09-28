import { Schema } from "effect";
import { ArtifactName, Revision, decode } from "./index.ts";

const ObjectData = Schema.Record(Schema.String, Schema.Unknown);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
export const DiagramVersion = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const NativeDiagram = Schema.Struct({
  type: Schema.Literal("excalidraw"),
  version: Schema.Literal(2),
  source: Schema.optionalKey(Schema.String),
  elements: Schema.Array(ObjectData).check(Schema.isMaxLength(10_000)),
  appState: ObjectData,
  files: Schema.Record(Id, ObjectData),
});
export type NativeDiagram = typeof NativeDiagram.Type;
export const PropertyChanges = Schema.Struct({
  set: ObjectData,
  remove: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type PropertyChanges = typeof PropertyChanges.Type;
export const DiagramDelta = Schema.Struct({
  elements: Schema.Array(
    Schema.Struct({
      id: Id,
      replace: Schema.optionalKey(Schema.Boolean),
      ...PropertyChanges.fields,
    }),
  ),
  deleted: Schema.Array(Id),
  order: Schema.optionalKey(Schema.Array(Id)),
  appState: Schema.optionalKey(PropertyChanges),
  files: Schema.Record(Id, Schema.NullOr(ObjectData)),
});
export type DiagramDelta = typeof DiagramDelta.Type;
export const DiagramSyncCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("read"),
    name: ArtifactName,
    since: Schema.optionalKey(DiagramVersion),
  }),
  Schema.Struct({
    action: Schema.Literal("write"),
    name: ArtifactName,
    expectedVersion: DiagramVersion,
    delta: DiagramDelta,
  }),
  Schema.Struct({
    action: Schema.Literal("replace"),
    name: ArtifactName,
    expectedVersion: DiagramVersion,
    document: NativeDiagram,
  }),
  Schema.Struct({
    action: Schema.Literal("propose"),
    name: ArtifactName,
    expectedVersion: DiagramVersion,
    delta: DiagramDelta,
    note: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  Schema.Struct({ action: Schema.Literal("proposal"), name: ArtifactName }),
  Schema.Struct({ action: Schema.Literal("status"), name: ArtifactName }),
  Schema.Struct({
    action: Schema.Literal("message"),
    name: ArtifactName,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
]);
export type DiagramSyncCommand = typeof DiagramSyncCommand.Type;
export const DiagramProposal = Schema.Struct({
  id: Id,
  baseVersion: DiagramVersion,
  content: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
  note: Schema.String.check(Schema.isMaxLength(4000)),
});
export type DiagramProposal = typeof DiagramProposal.Type;
const Receipt = { name: ArtifactName, version: DiagramVersion, revision: Revision };
export const DiagramSyncReply = Schema.Union([
  Schema.Struct({ type: Schema.Literal("full"), ...Receipt, document: NativeDiagram }),
  Schema.Struct({ type: Schema.Literals(["delta", "applied"]), ...Receipt, delta: DiagramDelta }),
  Schema.Struct({
    type: Schema.Literal("conflict"),
    ...Receipt,
    delta: Schema.optionalKey(DiagramDelta),
  }),
  Schema.Struct({
    type: Schema.Literal("proposal"),
    ...Receipt,
    proposal: Schema.NullOr(DiagramProposal),
  }),
  Schema.Struct({ type: Schema.Literals(["message", "status"]), ...Receipt }),
]);
export type DiagramSyncReply = typeof DiagramSyncReply.Type;

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function checkKeys(value: Record<string, unknown>) {
  if (Object.keys(value).some((key) => forbidden.has(key)))
    throw new Error("Invalid diagram property.");
}

export function parseNativeDiagram(input: unknown): NativeDiagram {
  const document = decode(NativeDiagram, input);
  const ids = new Set<string>();
  for (const element of document.elements) {
    checkKeys(element);
    const id = decode(Id, element.id);
    if (ids.has(id)) throw new Error(`Duplicate diagram element: ${id}.`);
    ids.add(id);
    if (typeof element.type !== "string") throw new Error(`Element ${id} needs a type.`);
    for (const field of ["x", "y", "width", "height"])
      if (typeof element[field] !== "number" || !Number.isFinite(element[field]))
        throw new Error(`Element ${id} needs a finite ${field}.`);
  }
  checkKeys(document.appState);
  checkKeys(document.files);
  return document;
}

export function emptyDelta(): DiagramDelta {
  return { elements: [], deleted: [], files: {} };
}

export function changedProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): PropertyChanges {
  const set = Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value),
    ),
  );
  const remove = Object.keys(before).filter((key) => !Object.hasOwn(after, key));
  return { set, ...(remove.length ? { remove } : {}) };
}

function hasChanges(changes: PropertyChanges) {
  return Object.keys(changes.set).length > 0 || Boolean(changes.remove?.length);
}

export function diagramDelta(before: NativeDiagram, after: NativeDiagram): DiagramDelta {
  const previous = new Map(before.elements.map((element) => [String(element.id), element]));
  const current = new Set(after.elements.map((element) => String(element.id)));
  const elements: DiagramDelta["elements"][number][] = [];
  for (const element of after.elements) {
    const id = String(element.id);
    const changes = changedProperties(previous.get(id) ?? {}, element);
    if (hasChanges(changes))
      elements.push({ id, ...changes, ...(previous.has(id) ? {} : { replace: true }) });
  }
  const deleted = [...previous.keys()].filter((id) => !current.has(id));
  const implicitOrder = [
    ...[...previous.keys()].filter((id) => current.has(id)),
    ...[...current.keys()].filter((id) => !previous.has(id)),
  ];
  const order = [...current];
  const appState = changedProperties(before.appState, after.appState);
  const files = Object.fromEntries([
    ...Object.entries(after.files).filter(
      ([id, file]) => JSON.stringify(before.files[id]) !== JSON.stringify(file),
    ),
    ...Object.keys(before.files)
      .filter((id) => !Object.hasOwn(after.files, id))
      .map((id) => [id, null]),
  ]);
  return {
    elements,
    deleted,
    files,
    ...(JSON.stringify(implicitOrder) === JSON.stringify(order) ? {} : { order }),
    ...(hasChanges(appState) ? { appState } : {}),
  };
}

function applyProperties(value: Record<string, unknown>, changes: PropertyChanges) {
  checkKeys(changes.set);
  const result = { ...value, ...changes.set };
  for (const key of changes.remove ?? []) delete result[key];
  return result;
}

export function applyDiagramDelta(document: NativeDiagram, input: DiagramDelta): NativeDiagram {
  const delta = decode(DiagramDelta, input);
  const elements = new Map(document.elements.map((element) => [String(element.id), element]));
  for (const id of delta.deleted) elements.delete(id);
  const edited = new Set<string>();
  for (const change of delta.elements) {
    if (edited.has(change.id) || delta.deleted.includes(change.id))
      throw new Error(`Repeated diagram element: ${change.id}.`);
    edited.add(change.id);
    const next = applyProperties(change.replace ? {} : (elements.get(change.id) ?? {}), change);
    if (next.id !== change.id) throw new Error("An element ID cannot change.");
    elements.set(change.id, next);
  }
  const order = delta.order ?? [...elements.keys()];
  if (
    order.length !== elements.size ||
    new Set(order).size !== elements.size ||
    order.some((id) => !elements.has(id))
  )
    throw new Error("Diagram order must contain every element exactly once.");
  const files = { ...document.files };
  checkKeys(delta.files);
  for (const [id, file] of Object.entries(delta.files)) {
    if (file === null) delete files[id];
    else files[id] = file;
  }
  return parseNativeDiagram({
    ...document,
    elements: order.map((id) => elements.get(id)!),
    appState: delta.appState
      ? applyProperties(document.appState, delta.appState)
      : document.appState,
    files,
  });
}

export function combineDiagramDeltas(deltas: readonly DiagramDelta[]): DiagramDelta {
  const elements = new Map<string, DiagramDelta["elements"][number]>();
  const deleted = new Set<string>();
  const files: Record<string, Record<string, unknown> | null> = {};
  let order: readonly string[] | undefined;
  let appState: PropertyChanges | undefined;
  const combine = (before: PropertyChanges, after: PropertyChanges): PropertyChanges => {
    const set = { ...before.set, ...after.set };
    for (const key of after.remove ?? []) delete set[key];
    const remove = [...new Set([...(before.remove ?? []), ...(after.remove ?? [])])].filter(
      (key) => !Object.hasOwn(after.set, key),
    );
    return { set, ...(remove.length ? { remove } : {}) };
  };
  for (const delta of deltas) {
    for (const id of delta.deleted) {
      elements.delete(id);
      deleted.add(id);
    }
    for (const change of delta.elements) {
      const previous = (change.replace ? undefined : elements.get(change.id)) ?? { set: {} };
      const result = combine(previous, change);
      elements.set(change.id, {
        id: change.id,
        ...result,
        ...(change.replace || ("replace" in previous && previous.replace) ? { replace: true } : {}),
      });
      deleted.delete(change.id);
    }
    checkKeys(delta.files);
    Object.assign(files, delta.files);
    if (delta.order) order = delta.order;
    else if (order)
      order = [
        ...order.filter((id) => !delta.deleted.includes(id)),
        ...delta.elements
          .filter((change) => !order!.includes(change.id))
          .map((change) => change.id),
      ];
    if (delta.appState) appState = combine(appState ?? { set: {} }, delta.appState);
  }
  return {
    elements: [...elements.values()],
    deleted: [...deleted],
    files,
    ...(order ? { order } : {}),
    ...(appState ? { appState } : {}),
  };
}
