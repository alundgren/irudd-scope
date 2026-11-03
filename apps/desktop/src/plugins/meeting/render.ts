import type { Block, Page } from "./contract.ts";

/** HTML for one block. Model text is escaped; callers still sanitize before use. */
export function renderBlock(_block: Block): string {
  throw new Error("Workstream A implements renderBlock.");
}
/** HTML for the title and every block. Each block is a `[data-block="id"]` element. */
export function renderPage(_page: Page): string {
  throw new Error("Workstream A implements renderPage.");
}
