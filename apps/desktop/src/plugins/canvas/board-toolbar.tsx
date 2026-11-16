import { useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Plus, Redo2, Trash2, Undo2 } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { cardTypes } from "./cards/registry.ts";
import type { CanvasHistoryState } from "./contract.ts";

function CanvasName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  return (
    <input
      key={name}
      className="canvas-name"
      aria-label="Canvas name"
      defaultValue={name}
      maxLength={160}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = name;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        if (next && next !== name) onRename(next);
        else event.currentTarget.value = name;
      }}
    />
  );
}

function AddCard({ onAdd }: { onAdd: (type: string, label: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="canvas-add"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus /> Add card
      </Button>
      {open && (
        <div className="canvas-add-menu" role="menu" aria-label="Card types">
          {cardTypes.map((type) => (
            <button
              key={type.type}
              role="menuitem"
              className="canvas-add-item"
              onClick={() => {
                setOpen(false);
                onAdd(type.type, type.label);
              }}
            >
              {type.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BoardToolbar({
  name,
  onRename,
  history,
  selected,
  onAdd,
  onStep,
  onRestack,
  onDelete,
}: {
  name: string;
  onRename: (name: string) => void;
  history: CanvasHistoryState | undefined;
  selected: boolean;
  onAdd: (type: string, label: string) => void;
  onStep: (direction: "undo" | "redo") => void;
  onRestack: (front: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="Board">
      <CanvasName name={name} onRename={onRename} />
      <AddCard onAdd={onAdd} />
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={history?.undoLabel ? `Undo ${history.undoLabel}` : "Undo"}
        title="Undo · Ctrl+Z"
        disabled={!history?.canUndo}
        onClick={() => onStep("undo")}
      >
        <Undo2 />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={history?.redoLabel ? `Redo ${history.redoLabel}` : "Redo"}
        title="Redo · Ctrl+Shift+Z"
        disabled={!history?.canRedo}
        onClick={() => onStep("redo")}
      >
        <Redo2 />
      </Button>
      {selected && (
        <>
          <Button size="sm" variant="ghost" onClick={() => onRestack(true)}>
            <ArrowUpToLine /> Bring to front
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onRestack(false)}>
            <ArrowDownToLine /> Send to back
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 /> Delete card
          </Button>
        </>
      )}
    </div>
  );
}
