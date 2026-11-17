import { Schema } from "effect";
import { keyBetween } from "../../order.ts";
import type { CanvasOp, CardContent } from "../../contract.ts";
import type { CardTools } from "../types.ts";
import {
  MAX_TEXT,
  nameOf,
  type Anchor,
  type Area,
  type BoxRecord,
  type BoxesContent,
  type BoxesRecord,
} from "./contract.ts";
import { GRID, snapGrid } from "./geometry.ts";

const NEW_BOX = { w: 160, h: 80 };
/** Space left between a new box and the box it is placed next to. */
const GAP = 3 * GRID;

const Ref = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/));
/** A record ID from read_diagram, or `$name` for a record added earlier in the same call. */
const RecordName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40));
const Kind = Schema.Literals(["box", "database", "queue", "circle", "diamond"]);
const Side = Schema.Literals(["right", "left", "above", "below"]);
const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT));
const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }));
const Size = Schema.Int.check(Schema.isBetween({ minimum: 40, maximum: 4000 }));

const Add = Schema.Struct({
  action: Schema.Literal("add"),
  ref: Schema.optionalKey(Ref),
  text: Text,
  kind: Schema.optionalKey(Kind),
  near: Schema.optionalKey(RecordName),
  side: Schema.optionalKey(Side),
  x: Schema.optionalKey(Coordinate),
  y: Schema.optionalKey(Coordinate),
  w: Schema.optionalKey(Size),
  h: Schema.optionalKey(Size),
});
const Connect = Schema.Struct({
  action: Schema.Literal("connect"),
  ref: Schema.optionalKey(Ref),
  from: RecordName,
  to: RecordName,
  label: Schema.optionalKey(Text),
});
const Update = Schema.Struct({
  action: Schema.Literal("update"),
  id: RecordName,
  text: Schema.optionalKey(Schema.NullOr(Text)),
  kind: Schema.optionalKey(Kind),
  label: Schema.optionalKey(Schema.NullOr(Text)),
  x: Schema.optionalKey(Coordinate),
  y: Schema.optionalKey(Coordinate),
  w: Schema.optionalKey(Size),
  h: Schema.optionalKey(Size),
});
const Remove = Schema.Struct({ action: Schema.Literal("remove"), id: RecordName });
const Change = Schema.Union([Add, Connect, Update, Remove]);
const Changes = Schema.Array(Change).check(Schema.isMinLength(1), Schema.isMaxLength(50));
type Change = typeof Change.Type;

const decodeChanges = Schema.decodeUnknownSync(Changes, { onExcessProperty: "error" });

class ToolError extends Error {}

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const STEP = {
  right: { x: 1, y: 0, word: "further right" },
  left: { x: -1, y: 0, word: "further left" },
  below: { x: 0, y: 1, word: "lower" },
  above: { x: 0, y: -1, word: "higher" },
} as const;

/** The connector ends that join two boxes along their facing sides. */
function facingAnchors(from: string, a: BoxRecord, to: string, b: BoxRecord): [Anchor, Anchor] {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy))
    return dx >= 0
      ? [
          { id: from, rx: 1, ry: 0.5 },
          { id: to, rx: 0, ry: 0.5 },
        ]
      : [
          { id: from, rx: 0, ry: 0.5 },
          { id: to, rx: 1, ry: 0.5 },
        ];
  return dy >= 0
    ? [
        { id: from, rx: 0.5, ry: 1 },
        { id: to, rx: 0.5, ry: 0 },
      ]
    : [
        { id: from, rx: 0.5, ry: 0 },
        { id: to, rx: 0.5, ry: 1 },
      ];
}

/**
 * Turns an agent's list of changes into ops against the card. Later changes see earlier ones,
 * so `$name` refers to a record added earlier in the same list.
 */
export function planBoxesEdit(content: CardContent, input: unknown) {
  let changes: readonly Change[];
  try {
    changes = decodeChanges(input);
  } catch (error) {
    throw new ToolError(
      `The changes are not valid: ${error instanceof Error ? error.message.slice(0, 600) : ""}`,
    );
  }
  const work: BoxesContent = { ...(content as BoxesContent) };
  const ops: CanvasOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  let top = Object.values(work).reduce<string | undefined>(
    (max, record) => (max === undefined || record.z > max ? record.z : max),
    undefined,
  );
  const nextZ = () => (top = keyBetween(top, undefined));
  let unnamed = 0;
  const newName = (ref: string | undefined) => {
    const id = `$${ref ?? `_${++unnamed}`}`;
    if (work[id]) throw new ToolError(`${id} is added twice.`);
    return id;
  };
  const find = (name: string): [string, BoxesRecord] => {
    const record = work[name];
    if (!record)
      throw new ToolError(
        name.startsWith("$")
          ? `${name} must be added earlier in the same changes.`
          : `There is no record ${name}. Read the diagram again.`,
      );
    return [name, record];
  };
  const area = (name: string): Area => {
    const [, record] = find(name);
    if (record.type === "connector") throw new ToolError(`${name} is a connector, not a box.`);
    return record;
  };
  const box = (name: string): BoxRecord => {
    const record = area(name);
    if (record.type !== "box") throw new ToolError(`${name} is a section, not a box.`);
    return record;
  };
  const blockers = (rect: Rect, except?: string) =>
    Object.entries(work).filter(
      ([id, record]) => id !== except && record.type === "box" && overlaps(rect, record),
    );

  /** Moves a new box along `side` in grid steps until it covers no other box. */
  const clear = (rect: Rect, side: keyof typeof STEP, name: string) => {
    const step = STEP[side];
    const start = { x: rect.x, y: rect.y };
    let covered: string[] = [];
    for (let tries = 0; tries < 500; tries++) {
      const hit = blockers(rect);
      if (!hit.length) break;
      if (!covered.length) covered = hit.map(([, record]) => nameOf(record as Area));
      rect.x += step.x * GRID;
      rect.y += step.y * GRID;
    }
    const moved = Math.abs(rect.x - start.x) + Math.abs(rect.y - start.y);
    if (moved)
      warnings.push(
        `Placed ${name} ${moved} ${step.word} than asked so it does not cover ${covered.join(", ")}.`,
      );
  };

  for (const change of changes) {
    if (change.action === "add") {
      const id = newName(change.ref);
      const w = snapGrid(change.w ?? NEW_BOX.w) || GRID;
      const h = snapGrid(change.h ?? NEW_BOX.h) || GRID;
      const rect: Rect = { x: 0, y: 0, w, h };
      const name = nameOf({ type: "box", kind: change.kind, text: change.text });
      if (change.x !== undefined || change.y !== undefined) {
        rect.x = snapGrid(change.x ?? 0);
        rect.y = snapGrid(change.y ?? 0);
        const hit = blockers(rect);
        if (hit.length)
          warnings.push(
            `${name} covers ${hit.map(([, record]) => nameOf(record as Area)).join(", ")}.`,
          );
      } else if (change.near) {
        const near = area(change.near);
        const side = change.side ?? "right";
        rect.x =
          side === "right"
            ? near.x + near.w + GAP
            : side === "left"
              ? near.x - GAP - w
              : near.x + (near.w - w) / 2;
        rect.y =
          side === "below"
            ? near.y + near.h + GAP
            : side === "above"
              ? near.y - GAP - h
              : near.y + (near.h - h) / 2;
        rect.x = snapGrid(rect.x);
        rect.y = snapGrid(rect.y);
        clear(rect, side, name);
      } else {
        const all = Object.values(work).filter((record) => record.type !== "connector") as Area[];
        if (all.length) {
          rect.x = snapGrid(Math.max(...all.map((record) => record.x + record.w)) + GAP);
          rect.y = snapGrid(Math.min(...all.map((record) => record.y)));
        }
        clear(rect, "right", name);
      }
      const value: BoxRecord = {
        type: "box",
        ...(change.kind && change.kind !== "box" ? { kind: change.kind } : {}),
        ...rect,
        ...(change.text ? { text: change.text } : {}),
        z: nextZ(),
      };
      work[id] = value;
      ops.push({ op: "put", id, value });
      summary.push(`Added ${name}`);
    } else if (change.action === "connect") {
      const id = newName(change.ref);
      const [from, to] = facingAnchors(change.from, box(change.from), change.to, box(change.to));
      if (change.from === change.to) throw new ToolError("A connector needs two different boxes.");
      const value = {
        type: "connector" as const,
        from,
        to,
        ...(change.label ? { label: change.label } : {}),
        z: nextZ(),
      };
      work[id] = value;
      ops.push({ op: "put", id, value });
      summary.push(`Connected ${nameOf(box(change.from))} to ${nameOf(box(change.to))}`);
    } else if (change.action === "update") {
      const [id, record] = find(change.id);
      const fields: Record<string, unknown> = {};
      if (record.type === "connector") {
        for (const key of ["text", "kind", "x", "y", "w", "h"] as const)
          if (change[key] !== undefined)
            throw new ToolError(`${id} is a connector; only its label can change.`);
        if (change.label !== undefined) fields.label = change.label || null;
      } else {
        if (change.label !== undefined)
          throw new ToolError(`${id} is not a connector; change its text instead.`);
        if (change.text !== undefined) fields.text = change.text || null;
        if (change.kind !== undefined) {
          if (record.type !== "box") throw new ToolError(`${id} is a section; it has no kind.`);
          fields.kind = change.kind === "box" ? null : change.kind;
        }
        for (const key of ["x", "y"] as const)
          if (change[key] !== undefined) fields[key] = snapGrid(change[key]);
        for (const key of ["w", "h"] as const)
          if (change[key] !== undefined) fields[key] = snapGrid(change[key]) || GRID;
      }
      if (!Object.keys(fields).length) throw new ToolError(`The change to ${id} changes nothing.`);
      const next = { ...record } as Record<string, unknown>;
      for (const [field, value] of Object.entries(fields))
        if (value === null) delete next[field];
        else next[field] = value;
      work[id] = next as BoxesRecord;
      ops.push({ op: "set", id, fields: fields as never });
      summary.push(
        `Changed ${record.type === "connector" ? `connector ${record.label ?? id}` : nameOf(record)}`,
      );
    } else {
      const [id, record] = find(change.id);
      ops.push({ op: "del", id });
      delete work[id];
      let linked = 0;
      if (record.type === "box")
        for (const [other, item] of Object.entries(work))
          if (item.type === "connector" && (item.from.id === id || item.to.id === id)) {
            ops.push({ op: "del", id: other });
            delete work[other];
            linked++;
          }
      summary.push(
        `Removed ${record.type === "connector" ? "a connector" : nameOf(record)}${linked ? ` and ${linked} connector${linked === 1 ? "" : "s"}` : ""}`,
      );
    }
  }
  return { ops, warnings, summary };
}

/** What read_diagram returns: every record with the fields an agent needs to change it. */
export function describeBoxes(content: CardContent) {
  const records = Object.entries(content as BoxesContent);
  return {
    boxes: records.flatMap(([id, record]) =>
      record.type === "box"
        ? [
            {
              id,
              kind: record.kind ?? "box",
              text: record.text ?? "",
              x: record.x,
              y: record.y,
              w: record.w,
              h: record.h,
            },
          ]
        : [],
    ),
    sections: records.flatMap(([id, record]) =>
      record.type === "section"
        ? [{ id, text: record.text ?? "", x: record.x, y: record.y, w: record.w, h: record.h }]
        : [],
    ),
    connectors: records.flatMap(([id, record]) =>
      record.type === "connector"
        ? [{ id, from: record.from.id, to: record.to.id, label: record.label ?? "" }]
        : [],
    ),
  };
}

export const boxesTools: CardTools = {
  describe: describeBoxes,
  plan: (content, input) => {
    try {
      return planBoxesEdit(content, input);
    } catch (error) {
      if (error instanceof ToolError) return { error: error.message };
      throw error;
    }
  },
  readGuide: [
    "Read the open card: a boxes-and-arrows diagram. Returns its version, its boxes (id, kind, text, x, y, w, h), sections (dashed areas with a title) and connectors (arrows from one box to another). Coordinates are in diagram units on a 20-unit grid; y grows downward.",
    "It also returns a PNG picture of the whole diagram, drawn the way the person's editor draws it. Look at it for text that overflows or is cut off, labels that sit on borders or other text, and lines drawn over each other. `picture` says how the picture maps to the diagram: pixel (px, py) shows the point (left + px / scale, top + py / scale).",
    "After edit_diagram, read again and look at the new picture to check the result.",
  ].join("\n"),
  editGuide: [
    "Change the open card. Each call is saved at once and shows in the person's editor; the person can undo your whole turn.",
    "`changes` is a list applied in order:",
    '- {"action":"add","text":"Redis","kind":"database","near":"<id>","side":"below","ref":"cache"} adds a box. kind is box, database, queue, circle or diamond. Place it next to an existing box with near and side (right, left, above or below; right by default), or give x and y. Scope keeps it on the grid and moves it clear of other boxes, and says so in warnings. w and h are optional.',
    '- {"action":"connect","from":"<id>","to":"$cache","label":"reads"} adds an arrow between two boxes.',
    '- {"action":"update","id":"<id>","text":"New name"} changes text, kind, x, y, w or h of a box, or the label of a connector. null removes text or a label.',
    '- {"action":"remove","id":"<id>"} removes a record; removing a box removes its connectors.',
    "Use ids from read_diagram. A ref names a record you add, so later changes in the same call can use it as $ref; the result maps each ref to its new id.",
    "Pass `version` from your last read_diagram. If the person changed the same things since, the call is refused with the current value and nothing changes; read again and decide.",
    "Pass a new `requestId` with each call. Sending the same requestId with the same changes again returns the first result without changing anything twice.",
  ].join("\n"),
};
