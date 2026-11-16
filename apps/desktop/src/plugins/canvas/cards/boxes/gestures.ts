import type { Anchor, Area, BoxRecord, BoxesContent, ConnectorRecord } from "./contract.ts";
import type { Draft } from "./draft.ts";
import {
  anchorAt,
  areas,
  facingAnchors,
  placement,
  resolve,
  snapDraw,
  snapEndpoint,
  snapMove,
  snapResize,
  titleWidth,
  type Candidate,
  type Guide,
  type Point,
  type Rect,
} from "./geometry.ts";

export type ConnectStart = Candidate & { id: string };
export type Gesture =
  | { kind: "move"; id: string; start: Point; origin: Record<string, Rect>; moved: boolean }
  | { kind: "resize"; id: string; handle: string; start: Point; origin: Area }
  | { kind: "draw"; id: string; start: Point; record: Area }
  | {
      kind: "connect";
      from: ConnectStart;
      candidate: Candidate;
      /** Set until the pointer moves; a click on a strip waits for a second click instead. */
      start?: Point;
      waiting: boolean;
      moved: boolean;
    }
  | { kind: "endpoint"; id: string; which: "from" | "to"; original: Anchor; candidate: Candidate }
  | { kind: "title"; id: string; start: Point; original: number; moved: boolean };

type Step = { gesture: Gesture; draft: Draft; guides: Guide[] };

const rect = ({ x, y, w, h }: Rect): Rect => ({ x, y, w, h });
const othersThan = (content: BoxesContent, ids: readonly string[]) =>
  areas(content)
    .filter(([id]) => !ids.includes(id))
    .map(([, area]) => rect(area));

/** Snaps a section title to the start, middle or end of its border. */
export function titleStop(position: number, travel: number) {
  if (travel <= 0) return { position: 0, middle: false };
  for (const target of [0, 0.5, 1])
    if (Math.abs(position - target) * travel <= (target === 0.5 ? 28 : 12))
      return { position: target, middle: target === 0.5 };
  return { position, middle: false };
}

/** True when a connect drag ends in empty space far enough from where it started. */
export function createsBox(gesture: Extract<Gesture, { kind: "connect" }>, zoom: number) {
  if (gesture.candidate.id) return false;
  return (
    Math.hypot(gesture.from.x - gesture.candidate.x, gesture.from.y - gesture.candidate.y) >
    30 / zoom
  );
}

/** The dashed box a connect drag into empty space would add, with its guide lines. */
export function ghostOf(gesture: Gesture | undefined, content: BoxesContent, zoom: number) {
  if (gesture?.kind !== "connect" || !createsBox(gesture, zoom)) return undefined;
  const source = content[gesture.from.id];
  return source?.type === "box" ? placement(source, gesture.candidate, zoom) : undefined;
}

/** Where a new connector ends on a box: the facing side when it was dropped on the middle. */
export function connectorEnds(
  from: ConnectStart,
  to: Candidate & { id: string },
  content: BoxesContent,
): [Anchor, Anchor] {
  const start = { id: from.id, rx: from.rx, ry: from.ry };
  if (to.rx !== 0.5 || to.ry !== 0.5) return [start, { id: to.id, rx: to.rx, ry: to.ry }];
  const a = content[from.id] as BoxRecord;
  const b = content[to.id] as BoxRecord;
  const hint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  return [start, facingAnchors(from.id, a, to.id, b, hint)[1]];
}

function moveStep(
  g: Extract<Gesture, { kind: "move" }>,
  p: Point,
  content: BoxesContent,
  zoom: number,
): Step {
  const dx = p.x - g.start.x;
  const dy = p.y - g.start.y;
  const moved = g.moved || Math.hypot(dx, dy) * zoom >= 5;
  const origin = g.origin[g.id];
  const snapped = snapMove(origin, dx, dy, othersThan(content, Object.keys(g.origin)), zoom);
  const draft: Draft = {};
  for (const [id, start] of Object.entries(g.origin))
    draft[id] = {
      ...(content[id] as Area),
      x: start.x + snapped.rect.x - origin.x,
      y: start.y + snapped.rect.y - origin.y,
    };
  return { gesture: { ...g, moved }, draft, guides: snapped.guides };
}

function endpointStep(
  g: Extract<Gesture, { kind: "endpoint" }>,
  p: Point,
  content: BoxesContent,
  zoom: number,
): Step {
  const candidate = snapEndpoint(anchorAt(p, content, zoom), p, content, zoom);
  const connector = content[g.id] as ConnectorRecord;
  const other = connector[g.which === "from" ? "to" : "from"];
  const attached = candidate.id && candidate.id !== other.id;
  const end = attached ? { id: candidate.id!, rx: candidate.rx, ry: candidate.ry } : g.original;
  return {
    gesture: { ...g, candidate },
    draft: { [g.id]: { ...connector, [g.which]: end } },
    guides: [],
  };
}

/** Follows the pointer during a gesture. `content` is the diagram before the gesture. */
export function dragTo(g: Gesture, p: Point, content: BoxesContent, zoom: number): Step {
  switch (g.kind) {
    case "move":
      return moveStep(g, p, content, zoom);
    case "endpoint":
      return endpointStep(g, p, content, zoom);
    case "connect": {
      const moved =
        g.moved || (g.start ? Math.hypot(p.x - g.start.x, p.y - g.start.y) * zoom >= 8 : true);
      return {
        gesture: { ...g, moved, candidate: anchorAt(p, content, zoom) },
        draft: {},
        guides: [],
      };
    }
    case "draw": {
      const snapped = snapDraw(g.start, p, othersThan(content, [g.id]), zoom);
      return {
        gesture: g,
        draft: { [g.id]: { ...g.record, ...snapped.rect } },
        guides: snapped.guides,
      };
    }
    case "resize": {
      const snapped = snapResize(
        rect(g.origin),
        g.handle,
        p.x - g.start.x,
        p.y - g.start.y,
        othersThan(content, [g.id]),
        zoom,
      );
      return {
        gesture: g,
        draft: { [g.id]: { ...g.origin, ...snapped.rect } },
        guides: snapped.guides,
      };
    }
    case "title": {
      const section = content[g.id] as Area & { type: "section" };
      const dx = p.x - g.start.x;
      const travel = Math.max(0, section.w - titleWidth(section) - 80);
      const raw = travel ? Math.max(0, Math.min(1, g.original + dx / travel)) : 0;
      const stop = titleStop(raw, travel);
      return {
        gesture: { ...g, moved: g.moved || Math.abs(dx) * zoom >= 5 },
        draft: { [g.id]: { ...section, title: stop.position } },
        guides: stop.middle ? [{ axis: "x", at: section.x + section.w / 2 }] : [],
      };
    }
  }
}

/** The point a connector end being placed sits at, on its box or free. */
export function candidatePoint(candidate: Candidate, content: BoxesContent): Point {
  const box = candidate.id ? content[candidate.id] : undefined;
  return box?.type === "box" ? resolve(candidate, box) : candidate;
}
