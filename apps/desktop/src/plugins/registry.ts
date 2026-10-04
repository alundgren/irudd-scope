import { decode } from "@irudd-scope/protocol";
import type { Tab } from "../workspace/contract.ts";
import { fileContract } from "./file/contract.ts";
import { diagramTabContract } from "./diagram/contract.ts";
import { planTabContract } from "./plan/contract.ts";

import { pullRequestsTabContract } from "./pull-requests/contract.ts";
import { retroTabContract } from "./retro/contract.ts";

const contracts = [
  fileContract,
  diagramTabContract,
  planTabContract,
  pullRequestsTabContract,
  retroTabContract,
];
export function validateTabState(tab: Tab, preserveFuture = false): void {
  const contract = contracts.find((entry) => entry.type === tab.type);
  if (contract && !(preserveFuture && tab.state.version > contract.version))
    decode(contract.state, tab.state);
}
