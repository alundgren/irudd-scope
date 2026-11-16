import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { findCardType } from "./cards/registry.ts";
import type { BoardCard } from "./contract.ts";

export type Frame = Pick<BoardCard, "x" | "y" | "w" | "h">;
type Gesture = {
  kind: "move" | "resize";
  startX: number;
  startY: number;
  frame: Frame;
  dragging: boolean;
};

const MIN_SIZE = 80;

/** One card on the board: its frame, title and read-only picture. */
export function CardFrame({
  id,
  card,
  zoom,
  selected,
  editable,
  onSelect,
  onFrame,
  onRename,
}: {
  id: string;
  card: BoardCard;
  zoom: number;
  selected: boolean;
  editable: boolean;
  onSelect: (id: string) => void;
  onFrame: (id: string, frame: Frame, label: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [moving, setMoving] = useState<Frame>();
  const [renaming, setRenaming] = useState(false);
  const gesture = useRef<Gesture>(undefined);
  const frame = moving ?? card;

  function start(kind: Gesture["kind"], event: ReactPointerEvent) {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(id);
    if (!editable) return;
    gesture.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      frame: card,
      dragging: false,
    };
  }
  function move(event: ReactPointerEvent) {
    const current = gesture.current;
    if (!current) return;
    // Capture only once the pointer really moves, so clicks and double-clicks still reach the title.
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) return;
      current.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const dx = Math.round((event.clientX - current.startX) / zoom);
    const dy = Math.round((event.clientY - current.startY) / zoom);
    const start = current.frame;
    setMoving(
      current.kind === "move"
        ? { ...start, x: start.x + dx, y: start.y + dy }
        : { ...start, w: Math.max(MIN_SIZE, start.w + dx), h: Math.max(MIN_SIZE, start.h + dy) },
    );
  }
  function end() {
    const current = gesture.current;
    gesture.current = undefined;
    if (!current || !moving) return setMoving(undefined);
    const changed =
      moving.x !== card.x || moving.y !== card.y || moving.w !== card.w || moving.h !== card.h;
    if (changed)
      onFrame(id, moving, `${current.kind === "move" ? "Move" : "Resize"} ${card.title}`);
    setMoving(undefined);
  }
  function cancel() {
    gesture.current = undefined;
    setMoving(undefined);
  }

  return (
    <div
      role="group"
      aria-label={card.title}
      data-card-id={id}
      tabIndex={0}
      className={`canvas-card${selected ? " canvas-card-selected" : ""}`}
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
      onPointerDown={(event) => start("move", event)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancel}
      onFocus={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && gesture.current) {
          event.stopPropagation();
          cancel();
        }
        if (event.key === "F2" && editable) setRenaming(true);
      }}
    >
      <div className="canvas-card-title" onDoubleClick={() => editable && setRenaming(true)}>
        {renaming ? (
          <input
            className="canvas-card-title-input"
            aria-label="Card title"
            defaultValue={card.title}
            autoFocus
            maxLength={160}
            onPointerDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = card.title;
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              setRenaming(false);
              const title = event.currentTarget.value.trim();
              if (title && title !== card.title) onRename(id, title);
            }}
          />
        ) : (
          <span>{card.title}</span>
        )}
      </div>
      <div className="canvas-card-body">
        <span className="canvas-card-empty">
          {findCardType(card.type)?.label ?? "Needs a newer Scope"}
        </span>
      </div>
      {selected && editable && (
        <div
          className="canvas-card-resize"
          aria-hidden="true"
          onPointerDown={(event) => start("resize", event)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={cancel}
        />
      )}
    </div>
  );
}
