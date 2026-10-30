import { GuestTabState } from "../guest/contract.ts";
import type { Artifact } from "@irudd-scope/protocol";
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

const contracts = [
  { type: "guest", version: 1, state: GuestTabState },
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
];
export function validateTabState(tab: Tab, preserveFuture = false): void {
  const contract = contracts.find((entry) => entry.type === tab.type);
  if (contract && !(preserveFuture && tab.state.version > contract.version))
    decode(contract.state, tab.state);
}

export function isBuiltinTab(tab: Pick<Tab, "type">): boolean {
  const contract = contracts.find((entry) => entry.type === tab.type);
  return !!contract && "category" in contract && contract.category === "builtin";
}

/** Only registered ordinary views with an explicit owner-access contract can be shared. */
export function guestSourceKind(
  tab: Tab | undefined,
  artifact?: Artifact,
): "file" | "plan" | "folder" | undefined {
  const type = tab?.type ?? (artifact?.kind === "plan" ? "plan" : "file");
  const contract = contracts.find((entry) => entry.type === type);
  if (!contract || isBuiltinTab({ type }) || !["file", "plan", "folder"].includes(type)) return;
  if (tab) {
    if (tab.state.version !== contract.version) return;
    try {
      validateTabState(tab);
    } catch {
      return;
    }
  }
  if (type === "folder") return !artifact && tab ? "folder" : undefined;
  if (type === "plan") return artifact?.kind === "plan" ? "plan" : undefined;
  return artifact &&
    ["html", "markdown", "text", "image", "file", "excalidraw"].includes(artifact.kind)
    ? "file"
    : undefined;
}
