import type { EditOp, Page } from "./contract.ts";

export type AppliedOps = {
  page: Page;
  /** Ids of blocks added or changed, in op order, so the view can scroll to the latest. */
  changed: string[];
  rejected: { op: EditOp; reason: string }[];
};

export function emptyPage(): Page {
  throw new Error("Workstream A implements emptyPage.");
}
/** Applies ops in order. A bad op is reported in `rejected` and never throws. */
export function applyOps(_page: Page, _ops: readonly EditOp[]): AppliedOps {
  throw new Error("Workstream A implements applyOps.");
}
/** The compact page text the edit model reads. */
export function pageSource(_page: Page): string {
  throw new Error("Workstream A implements pageSource.");
}
