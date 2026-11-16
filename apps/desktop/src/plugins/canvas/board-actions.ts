import type { Dispatch, SetStateAction } from "react";
import { arrange } from "./arrange.ts";
import type { Bounds } from "./camera.ts";
import type { BoardCard, CanvasCamera, CanvasOp } from "./contract.ts";
import { keyBetween } from "./order.ts";
import type { CanvasWrite } from "./use-canvas.ts";

const BOARD = { board: true } as const;
const NEW_CARD = { w: 640, h: 400 };

const describe = (cards: Record<string, BoardCard>, ids: readonly string[]) =>
  ids.length === 1 ? cards[ids[0]].title : `${ids.length} cards`;

/** Board changes made from the toolbar, the bottom bar and the keyboard. Each is one undo step. */
export function boardActions({
  cards,
  ordered,
  selected,
  camera,
  view,
  write,
  setSelection,
  focus,
}: {
  cards: Record<string, BoardCard>;
  ordered: readonly (readonly [string, BoardCard])[];
  selected: readonly string[];
  camera: CanvasCamera;
  view: () => Bounds;
  write: CanvasWrite;
  setSelection: Dispatch<SetStateAction<ReadonlySet<string>>>;
  focus: () => void;
}) {
  const top = ordered.at(-1)?.[1].z;
  const bottom = ordered[0]?.[1].z;
  function addCard(type: string, label: string) {
    const { w, h } = view();
    const value: BoardCard = {
      type,
      title: label,
      x: Math.round(camera.x + w / camera.zoom / 2 - NEW_CARD.w / 2),
      y: Math.round(camera.y + h / camera.zoom / 2 - NEW_CARD.h / 2),
      ...NEW_CARD,
      z: keyBetween(top, undefined),
    };
    void write(BOARD, `Add ${label}`, [{ op: "put", id: "$card", value }]).then((result) => {
      if (result.ok) setSelection(new Set([result.refs.$card]));
    });
  }
  function restack(front: boolean) {
    const ops: CanvasOp[] = [];
    let z = front ? top : bottom;
    for (const id of front ? selected : selected.toReversed()) {
      z = front ? keyBetween(z, undefined) : keyBetween(undefined, z);
      ops.push({ op: "set", id, fields: { z } });
    }
    if (ops.length)
      void write(
        BOARD,
        `${front ? "Bring" : "Send"} ${describe(cards, selected)} to ${front ? "front" : "back"}`,
        ops,
      );
  }
  function remove() {
    if (!selected.length) return;
    void write(
      BOARD,
      `Delete ${describe(cards, selected)}`,
      selected.map((id) => ({ op: "del", id })),
    );
    setSelection(new Set());
    focus();
  }
  function tidy() {
    const ids = selected.length > 1 ? selected : ordered.map(([id]) => id);
    const placed = arrange(ids.map((id) => ({ id, ...cards[id] })));
    const ops: CanvasOp[] = [...placed]
      .filter(([id, at]) => cards[id].x !== at.x || cards[id].y !== at.y)
      .map(([id, at]) => ({ op: "set", id, fields: at }));
    if (ops.length) void write(BOARD, `Arrange ${describe(cards, ids)}`, ops);
  }
  return { addCard, restack, remove, tidy };
}
