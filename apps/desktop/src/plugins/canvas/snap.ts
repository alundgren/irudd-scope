import type { Bounds } from "./camera.ts";
import { CARD_SIZE } from "./contract.ts";

/** Snapping reaches this far on screen, whatever the zoom. */
export const SNAP_PIXELS = 6;

export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
type Axis = "x" | "y";

const span = (frame: Bounds, axis: Axis) =>
  axis === "x" ? ([frame.x, frame.w] as const) : ([frame.y, frame.h] as const);
const lines = (frame: Bounds, axis: Axis) => {
  const [start, size] = span(frame, axis);
  return [start, start + size / 2, start + size];
};

type Match = { delta: number; at: number; other: Bounds };

/** The smallest move that lines one of `moving` up with an edge or center of another card. */
function closest(moving: number[], others: readonly Bounds[], axis: Axis, reach: number) {
  let best: Match | undefined;
  for (const other of others)
    for (const target of lines(other, axis))
      for (const line of moving) {
        const delta = target - line;
        if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta)))
          best = { delta, at: target, other };
      }
  return best;
}

function guide(axis: Axis, match: Match, frame: Bounds): Guide {
  // A line at a fixed x runs down across both cards, and one at a fixed y runs across them.
  const across: Axis = axis === "x" ? "y" : "x";
  const [start, size] = span(frame, across);
  const [otherStart, otherSize] = span(match.other, across);
  return {
    axis,
    at: match.at,
    from: Math.min(start, otherStart),
    to: Math.max(start + size, otherStart + otherSize),
  };
}

/**
 * Lines a moved or resized card up with nearby cards' edges and centers. A move snaps the
 * whole card; a resize from the bottom-right corner snaps only its right and bottom edges.
 */
export function snapFrame(
  frame: Bounds,
  kind: "move" | "resize",
  others: readonly Bounds[],
  zoom: number,
): { frame: Bounds; guides: Guide[] } {
  const reach = SNAP_PIXELS / zoom;
  const next = { ...frame };
  const guides: Guide[] = [];
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "w" : "h";
    const moving = kind === "move" ? lines(frame, axis) : [frame[axis] + frame[size]];
    const match = closest(moving, others, axis, reach);
    if (!match) continue;
    const delta = Math.round(match.delta);
    // A snap never makes a card smaller or larger than a card may be.
    const sized = frame[size] + delta;
    if (kind === "resize" && (sized < CARD_SIZE.min || sized > CARD_SIZE.max)) continue;
    if (kind === "move") next[axis] += delta;
    else next[size] += delta;
    guides.push(guide(axis, match, next));
  }
  return { frame: next, guides };
}
