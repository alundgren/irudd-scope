import { promptsTabContract } from "./prompts/contract.ts";
import { memoryTabContract } from "./memory/contract.ts";
import { decode } from "@irudd-scope/protocol";
import type { Tab } from "../workspace/contract.ts";
import { fileContract } from "./file/contract.ts";
import { sketchpadTabContract } from "./sketchpad/contract.ts";
import { planTabContract } from "./plan/contract.ts";

import { pullRequestsTabContract } from "./pull-requests/contract.ts";
import { retroTabContract } from "./retro/contract.ts";
import { folderTabContract } from "./folder/contract.ts";
import { harnessesTabContract } from "./harnesses/contract.ts";
import { sessionsTabContract } from "./sessions/contract.ts";
import { canvasTabContract } from "./canvas/contract.ts";

const contracts = [
  promptsTabContract,
  memoryTabContract,
  fileContract,
  sketchpadTabContract,
  planTabContract,
  pullRequestsTabContract,
  retroTabContract,
  folderTabContract,
  harnessesTabContract,
  sessionsTabContract,
  canvasTabContract,
];
export function validateTabState(tab: Tab, preserveFuture = false): void {
  const contract = contracts.find((entry) => entry.type === tab.type);
  if (contract && !(preserveFuture && tab.state.version > contract.version))
    decode(contract.state, tab.state);
}

/** Tabs that start permanent, so the Trashcan rule for unseen temporary tabs never moves them. */
export function createsPermanentTab(tab: Pick<Tab, "type">): boolean {
  const contract = contracts.find((entry) => entry.type === tab.type);
  return !!contract && "permanentOnCreate" in contract && contract.permanentOnCreate;
}

export function isBuiltinTab(tab: Pick<Tab, "type">): boolean {
  const contract = contracts.find((entry) => entry.type === tab.type);
  return !!contract && "category" in contract && contract.category === "builtin";
}
