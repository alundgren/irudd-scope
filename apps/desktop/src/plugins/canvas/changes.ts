import type { CanvasOp, CardContent, KeptField } from "./contract.ts";

type Rec = Record<string, unknown>;
/** A field a change writes; `*` stands for the whole record. */
export type Touch = { id: string; field: string };

export class ChangeError extends Error {}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => sameValue((a as Rec)[key], (b as Rec)[key]));
}

function setFields(record: Rec, fields: Rec): Rec {
  const next = { ...record };
  for (const [field, value] of Object.entries(fields))
    if (value === null) delete next[field];
    else next[field] = value;
  return next;
}

/** Applies ops to a copy of the content and returns the ops that undo them, newest first. */
export function applyOps(content: CardContent, ops: readonly CanvasOp[]) {
  const next: CardContent = { ...content };
  const inverse: CanvasOp[] = [];
  for (const op of ops) {
    const old = next[op.id];
    if (op.op === "put") {
      inverse.unshift(
        old ? { op: "put", id: op.id, value: old as never } : { op: "del", id: op.id },
      );
      next[op.id] = op.value;
    } else if (op.op === "set") {
      if (!old) throw new ChangeError(`Record ${op.id} does not exist.`);
      const previous = Object.fromEntries(
        Object.keys(op.fields).map((field) => [field, field in old ? old[field] : null]),
      );
      inverse.unshift({ op: "set", id: op.id, fields: previous as never });
      next[op.id] = setFields(old, op.fields);
    } else {
      if (!old) throw new ChangeError(`Record ${op.id} does not exist.`);
      inverse.unshift({ op: "put", id: op.id, value: old as never });
      delete next[op.id];
    }
  }
  return { content: next, inverse };
}

export function touches(ops: readonly CanvasOp[]): Touch[] {
  return ops.flatMap((op) =>
    op.op === "set"
      ? Object.keys(op.fields).map((field) => ({ id: op.id, field }))
      : [{ id: op.id, field: "*" }],
  );
}

/** The first field both lists change, if any. A whole-record op overlaps every field. */
export function overlap(a: readonly Touch[], b: readonly Touch[]): Touch | undefined {
  for (const left of a)
    for (const right of b)
      if (
        left.id === right.id &&
        (left.field === "*" || right.field === "*" || left.field === right.field)
      )
        return right.field === "*" ? left : right;
  return undefined;
}

type Written = { kind: "absent" } | { kind: "record"; value: Rec } | { kind: "fields"; value: Rec };

/** What each record looked like right after a step, as far as the step itself decided. */
function writtenBy(ops: readonly CanvasOp[]): Map<string, Written> {
  const written = new Map<string, Written>();
  for (const op of ops) {
    const before = written.get(op.id);
    if (op.op === "put") written.set(op.id, { kind: "record", value: op.value });
    else if (op.op === "del") written.set(op.id, { kind: "absent" });
    else if (before?.kind === "record")
      written.set(op.id, { kind: "record", value: setFields(before.value, op.fields) });
    else
      written.set(op.id, {
        kind: "fields",
        value: { ...(before?.kind === "fields" ? before.value : {}), ...op.fields },
      });
  }
  return written;
}

const fieldValue = (record: Rec | undefined, field: string) =>
  record && field in record ? record[field] : null;

/**
 * Builds the ops that undo a step, leaving alone every record or field that changed after it.
 * The left-alone fields are returned so the view can say what it kept.
 */
export function guardedInverse(
  content: CardContent,
  ops: readonly CanvasOp[],
  inverse: readonly CanvasOp[],
) {
  const written = writtenBy(ops);
  const kept: KeptField[] = [];
  const result: CanvasOp[] = [];
  for (const op of inverse) {
    const after = written.get(op.id);
    const current = content[op.id];
    if (!after) continue;
    if (op.op === "set") {
      const fields = Object.fromEntries(
        Object.entries(op.fields).filter(([field]) => {
          const expected = after.kind === "absent" ? null : fieldValue(after.value, field);
          const unchanged =
            current !== undefined && sameValue(fieldValue(current, field), expected);
          if (!unchanged) kept.push({ id: op.id, field });
          return unchanged;
        }),
      );
      if (Object.keys(fields).length) result.push({ ...op, fields: fields as never });
      continue;
    }
    const unchanged =
      after.kind === "absent"
        ? current === undefined
        : after.kind === "record"
          ? sameValue(current, after.value)
          : current !== undefined &&
            Object.entries(after.value).every(([field, value]) =>
              sameValue(fieldValue(current, field), value),
            );
    if (unchanged) result.push(op);
    else if (!(op.op === "del" && current === undefined)) kept.push({ id: op.id });
  }
  return { ops: result, kept };
}

export type HistoryRow = {
  seq: number;
  kind: "do" | "undo" | "redo";
  undoes: number | null;
  label: string;
};

/** The person's or one agent's undo and redo stacks in one scope, oldest first. */
export function historyStacks(rows: readonly HistoryRow[]) {
  const undo: HistoryRow[] = [];
  let redo: HistoryRow[] = [];
  const drop = (stack: HistoryRow[], seq: number | null) => {
    const index = stack.findIndex((row) => row.seq === seq);
    if (index >= 0) stack.splice(index, 1);
  };
  for (const row of rows) {
    if (row.kind === "do") {
      undo.push(row);
      redo = [];
    } else if (row.kind === "undo") {
      drop(undo, row.undoes);
      redo.push(row);
    } else {
      drop(redo, row.undoes);
      undo.push(row);
    }
  }
  return { undo, redo };
}

/** Replaces `$` names with new IDs everywhere in the ops, including inside record values. */
export function resolveRefs(ops: readonly CanvasOp[], newId: () => string) {
  const refs: Record<string, string> = {};
  for (const op of ops)
    if (op.id.startsWith("$")) {
      if (op.op !== "put" && !refs[op.id])
        throw new ChangeError(`${op.id} must be created before it is changed.`);
      if (op.op === "put" && refs[op.id]) throw new ChangeError(`${op.id} is created twice.`);
      refs[op.id] ??= newId();
    }
  const replace = (value: unknown): unknown =>
    typeof value === "string" && value.startsWith("$")
      ? (refs[value] ?? value)
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
          : value;
  return { ops: replace(ops) as CanvasOp[], refs };
}
