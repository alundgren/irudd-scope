import type { Bounds } from "./camera.ts";

export const ARRANGE_GAP = 40;

/**
 * Lays cards out in rows, in reading order of where they are now (top to bottom, then left
 * to right). Sizes stay; rows wrap so the result is about as wide as it is tall.
 */
export function arrange(cards: readonly (Bounds & { id: string })[]) {
  if (!cards.length) return new Map<string, { x: number; y: number }>();
  const ordered = cards.toSorted((a, b) => a.y - b.y || a.x - b.x);
  const area = ordered.reduce(
    (total, card) => total + (card.w + ARRANGE_GAP) * (card.h + ARRANGE_GAP),
    0,
  );
  const width = Math.max(Math.sqrt(area), ...ordered.map((card) => card.w));
  const left = Math.min(...ordered.map((card) => card.x));
  let x = left;
  let y = Math.min(...ordered.map((card) => card.y));
  let rowHeight = 0;
  const placed = new Map<string, { x: number; y: number }>();
  for (const card of ordered) {
    // A card starts a new row when more than half of it would pass the target width.
    if (x > left && x + card.w / 2 > left + width) {
      x = left;
      y += rowHeight + ARRANGE_GAP;
      rowHeight = 0;
    }
    placed.set(card.id, { x, y });
    x += card.w + ARRANGE_GAP;
    rowHeight = Math.max(rowHeight, card.h);
  }
  return placed;
}
