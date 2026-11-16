import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { BoardToolbar } from "./board-toolbar.tsx";
import { CardFrame, type Frame } from "./card-frame.tsx";
import type { BoardCard, CanvasCamera, CanvasSnapshot } from "./contract.ts";
import { byOrder, keyBetween } from "./order.ts";
import type { CanvasWrite } from "./use-canvas.ts";

const BOARD = { board: true } as const;
const NEW_CARD = { w: 640, h: 400 };

export const defaultCamera: CanvasCamera = { x: -80, y: -80, zoom: 1 };

// Wheel and trackpad scrolling pan the board; pinching or Ctrl+wheel zooms at the pointer.
function useWheel(
  surface: RefObject<HTMLDivElement | null>,
  camera: CanvasCamera,
  onCamera: (camera: CanvasCamera) => void,
) {
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!event.ctrlKey && !event.metaKey)
        return onCamera({
          ...camera,
          x: camera.x + event.deltaX / camera.zoom,
          y: camera.y + event.deltaY / camera.zoom,
        });
      const box = element.getBoundingClientRect();
      const zoom = Math.min(8, Math.max(0.05, camera.zoom * Math.exp(-event.deltaY / 200)));
      const px = event.clientX - box.left;
      const py = event.clientY - box.top;
      onCamera({
        zoom,
        x: camera.x + px / camera.zoom - px / zoom,
        y: camera.y + py / camera.zoom - py / zoom,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [camera, onCamera]);
}

function boardKey(
  event: KeyboardEvent,
  selected: string | undefined,
  step: (direction: "undo" | "redo") => void,
  remove: (id: string) => void,
) {
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (command && (key === "z" || key === "y")) {
    event.preventDefault();
    step(key === "y" || event.shiftKey ? "redo" : "undo");
  } else if ((event.key === "Delete" || event.key === "Backspace") && selected) {
    event.preventDefault();
    remove(selected);
  }
}

/** The board: cards you can add, move, resize, rename, restack and delete. */
export function Board({
  name,
  onRename,
  snapshot,
  camera,
  editable,
  active,
  onCamera,
  write,
  step,
}: {
  name: string;
  onRename: (name: string) => void;
  snapshot: CanvasSnapshot;
  camera: CanvasCamera;
  editable: boolean;
  active: boolean;
  onCamera: (camera: CanvasCamera) => void;
  write: CanvasWrite;
  step: (direction: "undo" | "redo") => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>();
  const cards = snapshot.board.cards;
  const ordered = useMemo(
    () => Object.entries(cards).toSorted(([, a], [, b]) => byOrder(a.z, b.z)),
    [cards],
  );
  useWheel(surface, camera, onCamera);
  useEffect(() => {
    if (selected && !cards[selected]) setSelected(undefined);
  }, [cards, selected]);

  const top = ordered.at(-1)?.[1].z;
  const bottom = ordered[0]?.[1].z;

  function addCard(type: string, label: string) {
    const box = surface.current?.getBoundingClientRect();
    const centerX = camera.x + (box?.width ?? 1200) / camera.zoom / 2;
    const centerY = camera.y + (box?.height ?? 800) / camera.zoom / 2;
    const value: BoardCard = {
      type,
      title: label,
      x: Math.round(centerX - NEW_CARD.w / 2),
      y: Math.round(centerY - NEW_CARD.h / 2),
      ...NEW_CARD,
      z: keyBetween(top, undefined),
    };
    void write(BOARD, `Add ${label}`, [{ op: "put", id: "$card", value }]).then((result) => {
      if (result.ok) setSelected(result.refs.$card);
    });
  }
  function restack(id: string, front: boolean) {
    const card = cards[id];
    if ((front ? top : bottom) === card.z) return;
    const z = front ? keyBetween(top, undefined) : keyBetween(undefined, bottom);
    void write(BOARD, `${front ? "Bring" : "Send"} ${card.title} to ${front ? "front" : "back"}`, [
      { op: "set", id, fields: { z } },
    ]);
  }
  function remove(id: string) {
    void write(BOARD, `Delete ${cards[id].title}`, [{ op: "del", id }]);
    setSelected(undefined);
    surface.current?.focus();
  }

  return (
    <div className="canvas-board-view">
      {editable && (
        <BoardToolbar
          name={name}
          onRename={onRename}
          history={snapshot.history[""]}
          selected={!!(selected && cards[selected])}
          onAdd={addCard}
          onStep={step}
          onRestack={(front) => selected && restack(selected, front)}
          onDelete={() => selected && remove(selected)}
        />
      )}
      <div
        ref={surface}
        className="canvas-surface"
        tabIndex={0}
        aria-label="Canvas board"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setSelected(undefined);
        }}
        onKeyDown={(event) => {
          if (active && editable && !(event.target instanceof HTMLInputElement))
            boardKey(event, selected, step, remove);
        }}
      >
        <div
          className="canvas-layer"
          style={{
            transform: `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)`,
          }}
        >
          {ordered.map(([id, card]) => (
            <CardFrame
              key={id}
              id={id}
              card={card}
              zoom={camera.zoom}
              selected={id === selected}
              editable={editable}
              onSelect={setSelected}
              onFrame={(id, frame: Frame, label) =>
                void write(BOARD, label, [{ op: "set", id, fields: frame }])
              }
              onRename={(id, title) =>
                void write(BOARD, `Rename ${cards[id].title}`, [
                  { op: "set", id, fields: { title } },
                ])
              }
            />
          ))}
        </div>
        {!ordered.length && <p className="canvas-empty">Add a card to start this canvas.</p>}
      </div>
    </div>
  );
}
