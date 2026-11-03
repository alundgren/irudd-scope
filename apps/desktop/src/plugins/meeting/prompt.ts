import type { Page } from "./contract.ts";

export const SYSTEM_PROMPT = "Workstream A writes the system prompt.";
export function buildUserMessage(_input: {
  page: Page;
  context: readonly string[];
  fresh: readonly string[];
  request: string | null;
}): string {
  throw new Error("Workstream A implements buildUserMessage.");
}
