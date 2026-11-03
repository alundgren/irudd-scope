import type { Canvas, CanvasOp, Page, Section, SectionSize } from "./contract.ts";

export type AppliedCanvasOps = {
  canvas: Canvas;
  /** Section ids added or changed, in op order. */
  changed: string[];
  /** Section ids created by these ops. */
  created: string[];
  rejected: { op: CanvasOp; reason: string }[];
};

export function emptyCanvas(): Canvas {
  throw new Error("W1 implements emptyCanvas.");
}
/** A page saved by the first test build, as one section named after its title. */
export function pageToCanvas(_page: Page): Canvas {
  throw new Error("W1 implements pageToCanvas.");
}
/** Applies ops in order. Never throws; bad ops are reported in `rejected`. */
export function applyCanvasOps(
  _canvas: Canvas,
  _ops: readonly CanvasOp[],
  _focus: string | null,
): AppliedCanvasOps {
  throw new Error("W1 implements applyCanvasOps.");
}
/** Exact id, then case-insensitive name, then name-word overlap of at least 0.5. */
export function findSection(_canvas: Canvas, _ref: string): Section | undefined {
  throw new Error("W1 implements findSection.");
}
export const SECTION_WIDTH: Record<SectionSize, number> = { s: 480, m: 760, l: 1080 };
