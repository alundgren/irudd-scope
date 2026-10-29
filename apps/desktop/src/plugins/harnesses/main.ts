import { clipboard } from "electron";
import { decode } from "@irudd-scope/protocol";
import type { MainPluginContext } from "../main-api.ts";
import { HarnessJsonRequest } from "./contract.ts";

const AGENT_REQUEST =
  "Run `irudd-scope harnesses guide`, then `irudd-scope harnesses read`. Tell me what differs between Codex, Claude Code, Cursor and Grok Build on my computer, and suggest what to keep in sync. Do not change anything yet.";

export function registerHarnessesIpc({ handle, harnesses }: MainPluginContext) {
  handle("scope:harnesses", () => harnesses.state());
  // The change notification reports progress and failure, so the reply waits for neither.
  handle("scope:scan-harnesses", () => {
    void harnesses.scan().catch(() => {});
  });
  handle("scope:copy-harnesses-request", () => clipboard.writeText(AGENT_REQUEST));
  handle("scope:copy-harness-json", (input) => {
    const { machine, harness } = decode(HarnessJsonRequest, input);
    const scan = harnesses.latestScan(machine);
    const report =
      harness === "shared"
        ? scan?.sharedSkills
        : scan?.harnesses.find((candidate) => candidate.id === harness);
    if (!report) throw new Error("That harness is not in the latest scan. Rescan and retry.");
    return clipboard.writeText(JSON.stringify(report, null, 2));
  });
}
