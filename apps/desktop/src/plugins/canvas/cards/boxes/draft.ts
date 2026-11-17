import { sameValue } from "../../changes.ts";
import type { CanvasOp } from "../../contract.ts";
import type { BoxesContent, BoxesRecord } from "./contract.ts";

/** Records a gesture has changed but not saved yet. `null` means removed. */
export type Draft = Record<string, BoxesRecord | null>;

export function withDraft(content: BoxesContent, draft: Draft): BoxesContent {
  if (!Object.keys(draft).length) return content;
  const next = { ...content };
  for (const [id, record] of Object.entries(draft)) {
    if (record) next[id] = record;
    else delete next[id];
  }
  return next;
}

/** The ops that turn `content` into `content` with `draft` applied, changing only what differs. */
export function draftOps(content: BoxesContent, draft: Draft): CanvasOp[] {
  const ops: CanvasOp[] = [];
  // Records first, then connectors, so a new connector never points at a box made after it.
  const entries = Object.entries(draft).toSorted(
    ([, a], [, b]) => (a?.type === "connector" ? 1 : 0) - (b?.type === "connector" ? 1 : 0),
  );
  for (const [id, record] of entries) {
    const before = content[id];
    if (!record) {
      if (before) ops.push({ op: "del", id });
      continue;
    }
    if (!before) {
      // An erased text or a plain kind is left out; JSON has no undefined.
      const value = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
      ops.push({ op: "put", id, value: value as never });
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(record)])) {
      const value = (record as Record<string, unknown>)[key];
      if (!sameValue((before as Record<string, unknown>)[key], value)) fields[key] = value ?? null;
    }
    if (Object.keys(fields).length) ops.push({ op: "set", id, fields: fields as never });
  }
  return ops;
}
