import type { KeyboardEvent } from "react";
import type { BoxesRecord } from "./contract.ts";
import { GRID } from "./geometry.ts";

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-GRID, 0],
  ArrowRight: [GRID, 0],
  ArrowUp: [0, -GRID],
  ArrowDown: [0, GRID],
};

/** Keys on the diagram itself; text fields handle their own keys. */
export function editorKey(
  event: KeyboardEvent,
  editor: {
    editable: boolean;
    /** A gesture is in progress. */
    busy: boolean;
    record: BoxesRecord | undefined;
    cancel: () => void;
    step: (direction: "undo" | "redo") => void;
    /** Starts typing in the selected box or connector label. */
    open: () => void;
    nudge: (dx: number, dy: number) => void;
    remove: () => void;
  },
) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    return;
  const key = event.key.toLowerCase();
  const command = event.metaKey || event.ctrlKey;
  // Escape during a drag puts things back; otherwise the host takes it to leave the editor.
  if (event.key === "Escape" && editor.busy) {
    event.preventDefault();
    return editor.cancel();
  }
  if (!editor.editable || editor.busy) return;
  const { record } = editor;
  let action: (() => void) | undefined;
  if (command && (key === "z" || key === "y"))
    action = () => editor.step(key === "y" || event.shiftKey ? "redo" : "undo");
  else if (event.key === "Enter" && record) action = editor.open;
  else if (ARROWS[event.key] && record && record.type !== "connector")
    action = () => editor.nudge(...ARROWS[event.key]);
  else if ((event.key === "Delete" || event.key === "Backspace") && record) action = editor.remove;
  if (!action) return;
  event.preventDefault();
  action();
}
