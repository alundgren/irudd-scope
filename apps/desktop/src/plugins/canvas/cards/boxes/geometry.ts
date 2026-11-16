import { byOrder } from "../../order.ts";
import type { Anchor, Area, BoxRecord, BoxesContent, ConnectorRecord } from "./contract.ts";

/** Boxes move, draw and resize in steps of this many content units. */
export const GRID = 20;
/** Screen pixels within which edges and centers line up. */
const ALIGN = 6;
/** Screen pixels within which a pointer reaches a box edge. */
const REACH = 18;

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };
/** A connector end being placed: on a box when `id` is set, otherwise a free point. */
export type Candidate = Point & { id?: string; rx: number; ry: number };
export type Guide = { axis: "x" | "y"; at: number };

export const snapGrid = (n: number) => Math.round(n / GRID) * GRID;
const inside = (p: Point, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Boxes and sections in drawing order: sections below boxes, then by `z`. */
export function areas(content: BoxesContent): [string, Area][] {
  return (
    Object.entries(content).filter(([, record]) => record.type !== "connector") as [string, Area][]
  ).toSorted(
    ([, a], [, b]) =>
      (a.type === "section" ? 0 : 1) - (b.type === "section" ? 0 : 1) || byOrder(a.z, b.z),
  );
}

export const connectors = (content: BoxesContent) =>
  Object.entries(content).filter(([, record]) => record.type === "connector") as [
    string,
    ConnectorRecord,
  ][];

export const boxes = (content: BoxesContent) =>
  areas(content).filter(([, record]) => record.type === "box") as [string, BoxRecord][];

export function bounds(content: BoxesContent): Rect | undefined {
  const all = areas(content).map(([, area]) => area);
  if (!all.length) return undefined;
  const x = Math.min(...all.map((a) => a.x));
  const y = Math.min(...all.map((a) => a.y));
  return {
    x,
    y,
    w: Math.max(...all.map((a) => a.x + a.w)) - x,
    h: Math.max(...all.map((a) => a.y + a.h)) - y,
  };
}

/** Where an anchor sits. Diamond anchors slide onto the diamond's outline. */
export function resolve(anchor: Anchor | Candidate, box: BoxRecord | undefined): Point {
  if (!box) return "x" in anchor ? { x: anchor.x, y: anchor.y } : { x: 0, y: 0 };
  if (box.kind === "diamond") {
    const dx = anchor.rx - 0.5;
    const dy = anchor.ry - 0.5;
    const scale = 0.5 / (Math.abs(dx) + Math.abs(dy) || 1);
    return { x: box.x + (0.5 + dx * scale) * box.w, y: box.y + (0.5 + dy * scale) * box.h };
  }
  return { x: box.x + anchor.rx * box.w, y: box.y + anchor.ry * box.h };
}

const onBox = (id: string, box: Rect, p: Point): Candidate => ({
  id,
  rx: (p.x - box.x) / box.w,
  ry: (p.y - box.y) / box.h,
  x: p.x,
  y: p.y,
});
const sides = (box: Rect, x: number, y: number) => [
  { x, y: box.y },
  { x, y: box.y + box.h },
  { x: box.x, y },
  { x: box.x + box.w, y },
];

/** The nearest box edge point under or near the pointer, or the grid point under it. */
export function anchorAt(p: Point, content: BoxesContent, zoom: number): Candidate {
  let best: (Candidate & { distance: number }) | undefined;
  for (const [id, box] of boxes(content).toReversed()) {
    if (inside(p, box)) {
      const closest = sides(box, p.x, p.y).reduce((a, c) =>
        distance(c, p) < distance(a, p) ? c : a,
      );
      return onBox(id, box, closest);
    }
    const x = Math.max(box.x, Math.min(box.x + box.w, p.x));
    const y = Math.max(box.y, Math.min(box.y + box.h, p.y));
    for (const candidate of sides(box, x, y)) {
      const d = distance(candidate, p);
      if (d <= REACH / zoom && (!best || d < best.distance))
        best = { ...onBox(id, box, candidate), distance: d };
    }
  }
  if (best) return { id: best.id, rx: best.rx, ry: best.ry, x: best.x, y: best.y };
  return { x: snapGrid(p.x), y: snapGrid(p.y), rx: 0, ry: 0 };
}

const DIAMOND_POINTS = [
  [0.5, 0],
  [1, 0.5],
  [0.5, 1],
  [0, 0.5],
  [0.75, 0.25],
  [0.75, 0.75],
  [0.25, 0.75],
  [0.25, 0.25],
];
const BOX_POINTS = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];

/** A dragged connector end snaps to a box's corners and side middles. */
export function snapEndpoint(
  candidate: Candidate,
  pointer: Point,
  content: BoxesContent,
  zoom: number,
): Candidate {
  const box = candidate.id ? content[candidate.id] : undefined;
  if (!candidate.id || box?.type !== "box") return candidate;
  let closest: { candidate: Candidate; distance: number } | undefined;
  for (const [rx, ry] of box.kind === "diamond" ? DIAMOND_POINTS : BOX_POINTS) {
    const point = resolve({ id: candidate.id, rx, ry }, box);
    const d = distance(pointer, point);
    if (d <= REACH / zoom && (!closest || d < closest.distance))
      closest = { candidate: { id: candidate.id, rx, ry, ...point }, distance: d };
  }
  return closest?.candidate ?? candidate;
}

/** Anchors on the sides of two boxes that face each other. */
export function facingAnchors(
  fromId: string,
  a: Rect,
  toId: string,
  b: Rect,
  hint: Point,
): [Anchor, Anchor] {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const pair = (lo1: number, hi1: number, lo2: number, hi2: number, preferred: number) => {
    if (hi1 < lo2) return [hi1, lo2];
    if (hi2 < lo1) return [lo1, hi2];
    const value = clamp(preferred, Math.max(lo1, lo2), Math.min(hi1, hi2));
    return [value, value];
  };
  const [ax, bx] = pair(a.x, a.x + a.w, b.x, b.x + b.w, hint.x);
  const [ay, by] = pair(a.y, a.y + a.h, b.y, b.y + b.h, hint.y);
  const at = (id: string, box: Rect, x: number, y: number) => ({
    id,
    rx: clamp((x - box.x) / box.w, 0, 1),
    ry: clamp((y - box.y) / box.h, 0, 1),
  });
  return [at(fromId, a, ax, ay), at(toId, b, bx, by)];
}

function normal(anchor: { rx: number; ry: number } | undefined, toward: Point): Point {
  if (!anchor) {
    const length = Math.hypot(toward.x, toward.y) || 1;
    return { x: toward.x / length, y: toward.y / length };
  }
  const candidates = [
    { distance: anchor.rx, x: -1, y: 0 },
    { distance: 1 - anchor.rx, x: 1, y: 0 },
    { distance: anchor.ry, x: 0, y: -1 },
    { distance: 1 - anchor.ry, x: 0, y: 1 },
  ];
  const min = Math.min(...candidates.map((candidate) => candidate.distance));
  return candidates
    .filter((candidate) => candidate.distance <= min + 0.001)
    .toSorted((l, r) => r.x * toward.x + r.y * toward.y - (l.x * toward.x + l.y * toward.y))[0];
}

/** A curve that leaves each box straight out of the side it starts on. */
export function curve(
  start: Point,
  end: Point,
  from: { rx: number; ry: number } | undefined,
  to: { rx: number; ry: number } | undefined,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const a = normal(from, { x: dx, y: dy });
  const b = normal(to, { x: -dx, y: -dy });
  const reach = Math.max(30, Math.min(200, Math.hypot(dx, dy) * 0.4));
  const c1 = { x: start.x + a.x * reach, y: start.y + a.y * reach };
  const c2 = { x: end.x + b.x * reach, y: end.y + b.y * reach };
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    middle: {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    },
  };
}

export function connectorPath(connector: ConnectorRecord, content: BoxesContent) {
  const fromBox = content[connector.from.id];
  const toBox = content[connector.to.id];
  if (fromBox?.type !== "box" || toBox?.type !== "box") return undefined;
  return curve(
    resolve(connector.from, fromBox),
    resolve(connector.to, toBox),
    connector.from,
    connector.to,
  );
}

/** Where a box dragged out of `source` into empty space lands, lined up with it when close. */
export function placement(source: BoxRecord, pointer: Point, zoom: number) {
  let x = snapGrid(pointer.x - source.w / 2);
  let y = snapGrid(pointer.y - source.h / 2);
  const guides: Guide[] = [];
  // Lining up with the source keeps quick chains of boxes straight.
  if (Math.abs(x - source.x) <= 14 / zoom) {
    x = source.x;
    guides.push({ axis: "x", at: source.x + source.w / 2 });
  }
  if (Math.abs(y - source.y) <= 14 / zoom) {
    y = source.y;
    guides.push({ axis: "y", at: source.y + source.h / 2 });
  }
  if (x === source.x && y === source.y) return undefined;
  return { rect: { x, y, w: source.w, h: source.h }, guides };
}

const targets = (other: Rect, axis: "x" | "y") => {
  const size = axis === "x" ? other.w : other.h;
  return [other[axis], other[axis] + size / 2, other[axis] + size];
};

/** Moves a frame on the grid, then lines its edges or center up with another area's. */
export function snapMove(start: Rect, dx: number, dy: number, others: Rect[], zoom: number) {
  const next = { ...start, x: snapGrid(start.x + dx), y: snapGrid(start.y + dy) };
  const guides: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? start.w : start.h;
    const raw = start[axis] + (axis === "x" ? dx : dy);
    let best: { delta: number; at: number } | undefined;
    for (const other of others)
      for (const own of [0, size / 2, size])
        for (const target of targets(other, axis)) {
          const delta = target - (raw + own);
          if (Math.abs(delta) <= ALIGN / zoom && (!best || Math.abs(delta) < Math.abs(best.delta)))
            best = { delta, at: target };
        }
    if (best) {
      next[axis] = Math.round(raw + best.delta);
      guides.push({ axis, at: best.at });
    }
  }
  return { rect: next, guides };
}

function alignValue(raw: number, axis: "x" | "y", others: Rect[], zoom: number) {
  let best: { target: number; delta: number } | undefined;
  for (const other of others)
    for (const target of targets(other, axis)) {
      const delta = Math.abs(target - raw);
      if (delta <= ALIGN / zoom && (!best || delta < best.delta)) best = { target, delta };
    }
  return best?.target;
}

/** The frame drawn from `start` to the pointer. */
export function snapDraw(start: Point, pointer: Point, others: Rect[], zoom: number) {
  const guides: Guide[] = [];
  const end = { x: 0, y: 0 };
  for (const axis of ["x", "y"] as const) {
    const aligned = alignValue(pointer[axis], axis, others, zoom);
    end[axis] = aligned ?? snapGrid(pointer[axis]);
    if (aligned !== undefined) guides.push({ axis, at: aligned });
  }
  return {
    rect: {
      x: Math.round(Math.min(end.x, start.x)),
      y: Math.round(Math.min(end.y, start.y)),
      w: Math.round(Math.abs(end.x - start.x)),
      h: Math.round(Math.abs(end.y - start.y)),
    },
    guides,
  };
}

/** Resizes from a handle such as "nw" or "e", keeping at least one grid step. */
export function snapResize(
  start: Rect,
  handle: string,
  dx: number,
  dy: number,
  others: Rect[],
  zoom: number,
) {
  const next = { ...start };
  const guides: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "w" : "h";
    const low = handle.includes(axis === "x" ? "w" : "n");
    const high = handle.includes(axis === "x" ? "e" : "s");
    if (!low && !high) continue;
    const fixed = low ? start[axis] + start[size] : start[axis];
    const raw = (low ? start[axis] : start[axis] + start[size]) + (axis === "x" ? dx : dy);
    let edge = snapGrid(raw);
    const aligned = alignValue(raw, axis, others, zoom);
    if (aligned !== undefined && (low ? aligned <= fixed - GRID : aligned >= fixed + GRID)) {
      edge = aligned;
      guides.push({ axis, at: edge });
    }
    edge = Math.round(low ? Math.min(edge, fixed - GRID) : Math.max(edge, fixed + GRID));
    next[axis] = low ? edge : fixed;
    next[size] = low ? fixed - edge : edge - fixed;
  }
  return { rect: next, guides };
}

/** Areas fully inside a section, which move with it. */
export function contained(id: string, section: Rect, content: BoxesContent): string[] {
  return areas(content)
    .filter(
      ([other, item]) =>
        other !== id &&
        item.x >= section.x &&
        item.y >= section.y &&
        item.x + item.w <= section.x + section.w &&
        item.y + item.h <= section.y + section.h,
    )
    .map(([other]) => other);
}

/** Where a section's title sits along its top border. */
export function titleOffset(section: Rect & { title?: number }, titleWidth: number) {
  return 40 + (section.title ?? 0) * Math.max(0, section.w - titleWidth - 80);
}

let measure: CanvasRenderingContext2D | null | undefined;
export function titleWidth(section: Rect & { text?: string }) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return 42;
  measure.font = "16px system-ui, sans-serif";
  return Math.min(
    Math.max(0, section.w - 24),
    Math.max(42, measure.measureText(section.text || "Section").width + 18),
  );
}
