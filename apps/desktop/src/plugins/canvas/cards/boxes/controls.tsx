import { useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "../../../../renderer/components/ui/button.tsx";
import {
  BOX_KINDS,
  type Area,
  type BoxKind,
  type BoxesContent,
  type ConnectorRecord,
} from "./contract.ts";
import { resolve, type Point } from "./geometry.ts";
import type { Gesture } from "./gestures.ts";
import { Outline } from "./outline.tsx";

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** The button under a box being typed in, and the searchable list of box kinds it opens. */
export function KindPicker({
  style,
  current,
  onPick,
}: {
  style: CSSProperties;
  current: BoxKind;
  onPick: (kind: BoxKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = BOX_KINDS.filter((kind) =>
    kind.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="boxes-kinds" style={style} onPointerDown={stop}>
      <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Change kind
      </Button>
      {open && (
        <div className="boxes-kind-list" role="menu" aria-label="Box kinds">
          <input
            className="boxes-kind-search"
            aria-label="Find a box kind"
            placeholder="Find a box kind"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter" && shown[0]) onPick(shown[0].id);
            }}
          />
          {shown.map((kind) => (
            <button
              key={kind.id}
              type="button"
              role="menuitemradio"
              aria-checked={kind.id === current}
              className="boxes-kind"
              onClick={() => onPick(kind.id)}
            >
              <svg width="24" height="16" viewBox="-1 -1 26 18" aria-hidden="true">
                <Outline
                  box={{
                    type: "box",
                    kind: kind.id === "box" ? undefined : kind.id,
                    x: 0,
                    y: 0,
                    w: 24,
                    h: 16,
                    z: "0",
                  }}
                />
              </svg>
              {kind.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Arrowhead switches for the selected connector, one per end. */
export function ArrowControls({
  style,
  connector,
  onToggle,
}: {
  style: CSSProperties;
  connector: ConnectorRecord;
  onToggle: (end: "arrowStart" | "arrowEnd") => void;
}) {
  return (
    <div
      className="boxes-arrows"
      style={style}
      role="toolbar"
      aria-label="Arrowheads"
      onPointerDown={stop}
    >
      <Button
        size="icon-sm"
        variant={connector.arrowStart ? "secondary" : "ghost"}
        aria-label="Arrow at start"
        aria-pressed={!!connector.arrowStart}
        onClick={() => onToggle("arrowStart")}
      >
        <ArrowLeft />
      </Button>
      <Button
        size="icon-sm"
        variant={connector.arrowEnd !== false ? "secondary" : "ghost"}
        aria-label="Arrow at end"
        aria-pressed={connector.arrowEnd !== false}
        onClick={() => onToggle("arrowEnd")}
      >
        <ArrowRight />
      </Button>
    </div>
  );
}

/** The bar that offers Undo right after a delete. */
export function UndoBar({
  text,
  onUndo,
  onClose,
}: {
  text: string;
  onUndo: () => void;
  onClose: () => void;
}) {
  return (
    <div className="boxes-undo-bar" role="status" onPointerDown={stop}>
      <span>{text}</span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          onClose();
          onUndo();
        }}
      >
        Undo
      </Button>
    </div>
  );
}

export type HintState = {
  editable: boolean;
  drawingSection: boolean;
  gesture: Gesture | undefined;
  typing: boolean;
  labeling: boolean;
  selected: string | undefined;
  content: BoxesContent;
};

/** What the next gesture does, shown as the diagram canvas's tooltip. */
export function hint(state: HintState) {
  const { gesture, content, selected } = state;
  const record = selected ? content[selected] : undefined;
  if (!state.editable) return "Scroll or drag with Space to look around";
  if (state.drawingSection) return "Drag on the canvas to draw a section";
  if (gesture?.kind === "connect")
    return gesture.waiting
      ? "Click a box to connect, or empty space to add a box · Esc cancels"
      : "Release on a box to connect, or on empty space to add a box";
  if (gesture?.kind === "endpoint") return "Release on a box edge to reattach";
  if (gesture) return "Esc cancels";
  if (state.labeling) return "Type a connector label · Enter to finish";
  if (state.typing)
    return record?.type === "section"
      ? "Type a section title · Enter to finish"
      : "Type a label · Esc or Ctrl+Enter to finish";
  if (record?.type === "connector")
    return "Drag an end to reattach · Enter or double-click to label · Delete removes";
  if (record?.type === "section")
    return "Drag a side or bottom border to move · corners resize · drag the title along the top";
  if (record) return "Drag to move · drag from an edge to connect · Enter or double-click to type";
  return "Drag on the canvas to draw a box";
}

/** The arrowhead switches, placed under the middle of the connector. */
export function ArrowControlsAt({
  connector,
  view,
  screen,
  onToggle,
}: {
  connector: ConnectorRecord;
  view: BoxesContent;
  screen: (p: Point) => { left: number; top: number };
  onToggle: (end: "arrowStart" | "arrowEnd") => void;
}) {
  const from = view[connector.from.id] as Area & { type: "box" };
  const to = view[connector.to.id] as Area & { type: "box" };
  const a = resolve(connector.from, from);
  const b = resolve(connector.to, to);
  const at = screen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return (
    <ArrowControls
      style={{ left: at.left - 40, top: at.top + 28 }}
      connector={connector}
      onToggle={onToggle}
    />
  );
}
