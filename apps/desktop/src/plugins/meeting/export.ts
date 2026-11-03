import type { Page } from "./contract.ts";

/** A standalone HTML document for the page, from already sanitized body HTML. */
export function standaloneHtml(_input: { page: Page; bodyHtml: string; css: string }): string {
  throw new Error("Workstream A implements standaloneHtml.");
}
