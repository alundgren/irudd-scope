import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { boardActions } from "./board-actions.ts";
import { BoardBar } from "./board-bar.tsx";
import { BoardToolbar } from "./board-toolbar.tsx";
import { boundsOf, fit, useCameraControls, zoomStep, type Bounds } from "./camera.ts";
import { CardFrame, type Frame } from "./card-frame.tsx";
import type { CanvasCamera, CanvasSnapshot } from "./contract.ts";
import { byOrder } from "./order.ts";
import { snapFrame, type Guide } from "./snap.ts";
import type { CanvasWrite } from "./use-canvas.ts";

const BOARD = { board: true } as const;

export const defaultCamera: CanvasCamera = { x: -80, y: -80, zoom: 1 };

function boardKey(
  event: KeyboardEvent,
  selected: ReadonlySet<string>,
  step: (direction: "undo" | "redo") => void,
  remove: () => void,
) {
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (command && (key === "z" || key === "y")) {
    event.preventDefault();
    step(key === "y" || event.shiftKey ? "redo" : "undo");
  } else if ((event.key === "Delete" || event.key === "Backspace") && selected.size) {
    event.preventDefault();
    remove();
  }
}

function Guides({ guides, zoom }: { guides: readonly Guide[]; zoom: number }) {
  return guides.map((guide) => (
    <div
      key={`${guide.axis}${guide.at}`}
      className={`canvas-guide canvas-guide-${guide.axis}`}
      data-guide={guide.axis}
      style={
        guide.axis === "x"
          ? {
              left: guide.at,
              top: guide.from,
              height: guide.to - guide.from,
              borderLeftWidth: 1 / zoom,
            }
          : {
              top: guide.at,
              left: guide.from,
              width: guide.to - guide.from,
              borderTopWidth: 1 / zoom,
            }
      }
    />
  ));
}

/** The board: cards you can add, move, resize, rename, restack, delete and arrange. */
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
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [guides, setGuides] = useState<Guide[]>([]);
  const cards = snapshot.board.cards;
  const ordered = useMemo(
    () => Object.entries(cards).toSorted(([, a], [, b]) => byOrder(a.z, b.z)),
    [cards],
  );
  const selected = useMemo(
    () => ordered.map(([id]) => id).filter((id) => selection.has(id)),
    [ordered, selection],
  );
  useCameraControls(surface, camera, onCamera, active);

  const view = (): Bounds => {
    const box = surface.current?.getBoundingClientRect();
    return { x: 0, y: 0, w: box?.width ?? 1200, h: box?.height ?? 800 };
  };

  function select(id: string, additive: boolean) {
    setSelection((current) => {
      if (!additive) return current.has(id) ? current : new Set([id]);
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  const actions = boardActions({
    cards,
    ordered,
    selected,
    camera,
    view,
    write,
    setSelection,
    focus: () => surface.current?.focus(),
  });
  function adjust(id: string, frame: Frame, kind: "move" | "resize", free: boolean) {
    if (free) {
      setGuides([]);
      return frame;
    }
    const others = ordered.filter(([other]) => other !== id).map(([, card]) => card);
    const snapped = snapFrame(frame, kind, others, camera.zoom);
    setGuides(snapped.guides);
    return snapped.frame;
  }

  return (
    <div className="canvas-board-view">
      {editable && (
        <BoardToolbar
          name={name}
          onRename={onRename}
          history={snapshot.history[""]}
          selected={selected.length > 0}
          onAdd={actions.addCard}
          onStep={step}
          onRestack={actions.restack}
          onDelete={actions.remove}
        />
      )}
      <div
        ref={surface}
        className="canvas-surface"
        tabIndex={0}
        aria-label="Canvas board"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setSelection(new Set());
        }}
        onKeyDown={(event) => {
          if (active && editable && !(event.target instanceof HTMLInputElement))
            boardKey(event, selection, step, actions.remove);
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
              selected={selection.has(id)}
              editable={editable}
              onSelect={select}
              adjust={adjust}
              onGestureEnd={() => setGuides([])}
              onFrame={(id, frame: Partial<Frame>, label) =>
                void write(BOARD, label, [{ op: "set", id, fields: frame }])
              }
              onRename={(id, title) =>
                void write(BOARD, `Rename ${cards[id].title}`, [
                  { op: "set", id, fields: { title } },
                ])
              }
            />
          ))}
          <Guides guides={guides} zoom={camera.zoom} />
        </div>
        {!ordered.length && <p className="canvas-empty">Add a card to start this canvas.</p>}
      </div>
      <BoardBar
        zoom={camera.zoom}
        editable={editable && ordered.length > 0}
        onZoom={(direction) => onCamera(zoomStep(camera, view(), direction))}
        onFit={() => onCamera(fit(boundsOf(ordered.map(([, card]) => card)), view()))}
        onArrange={actions.tidy}
      />
    </div>
  );
}
