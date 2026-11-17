import type { ComponentType } from "react";
import type { CanvasCamera, CanvasOp, CardContent } from "../contract.ts";
import { BoxesEditor } from "./boxes/editor.tsx";
import { BoxesPicture } from "./boxes/picture.tsx";

/** What a card type's editor gets from the canvas. Each `write` is one undo step in the card. */
export type CardEditorProps = {
  cardId: string;
  content: CardContent;
  /** Records an agent changed a moment ago, shown lit up for a few seconds. */
  highlighted?: readonly string[];
  editable: boolean;
  active: boolean;
  camera: CanvasCamera;
  onCamera: (camera: CanvasCamera) => void;
  write: (label: string, ops: CanvasOp[]) => void;
  step: (direction: "undo" | "redo") => void;
  /** An ID main has reserved for this canvas, so a new record shows before main confirms it. */
  newId: () => string;
  /**
   * Registers what the editor holds but has not written yet, such as unfinished typing. The tab
   * runs it before it closes or Scope quits, then waits for the writes. Returns the cleanup.
   */
  onFlush: (flush: () => void) => () => void;
  /** Where the editor puts its own tools, inside the card's floating toolbar. Null until shown. */
  tools: HTMLElement | null;
};

/** The renderer side of a card type: its full-tab editor and its picture on the board. */
export type CardView = {
  Editor: ComponentType<CardEditorProps>;
  Picture: ComponentType<{ content: CardContent }>;
};

const views: Record<string, CardView> = {
  boxes: { Editor: BoxesEditor, Picture: BoxesPicture },
};
export const findCardView = (type: string): CardView | undefined => views[type];
