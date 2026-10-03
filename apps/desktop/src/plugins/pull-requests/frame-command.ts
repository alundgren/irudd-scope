import { decode } from "@irudd-scope/protocol";
import {
  PullRequestsCommand,
  type PullRequestsSnapshot,
} from "@irudd-scope/protocol/pull-requests";
import type { FrameIdentity } from "./frame-sdk.ts";
export type FrameCall = FrameIdentity & { id: string; method: string; args: unknown[] };

export function frameCommand(
  call: FrameCall,
  snapshot: PullRequestsSnapshot,
  tabId: string,
): PullRequestsCommand {
  const base = { name: snapshot.artifact.name!, requestId: crypto.randomUUID(), tabId };
  if (call.method === "readState") return { name: snapshot.artifact.name!, action: "read" };
  if (call.method === "setState" || call.method === "patchState")
    return decode(PullRequestsCommand, {
      ...base,
      action: call.method === "setState" ? "state-set" : "state-patch",
      value: call.args[0],
      expectedVersion: call.args[1],
    });
  if (call.method === "deleteState")
    return decode(PullRequestsCommand, {
      ...base,
      action: "state-delete",
      keys: call.args[0],
      expectedVersion: call.args[1],
    });
  if (call.method === "sync") return { ...base, action: "sync" };
  if (call.method === "loadDetails")
    return decode(PullRequestsCommand, { ...base, action: "details", nodeIds: call.args[0] });
  const pr = snapshot.prs.find((row) => row.nodeId === call.args[0]);
  if (!pr) throw new Error("This pull request is no longer open. Refresh the inbox.");
  const row = { ...base, nodeId: pr.nodeId };
  switch (call.method) {
    case "detail":
      return decode(PullRequestsCommand, {
        ...row,
        action: "detail",
        ...(call.args[2] === undefined ? {} : { captured: call.args[2] }),
      });
    case "saveNote":
      return decode(PullRequestsCommand, {
        ...row,
        action: "note",
        expectedVersion: call.args[2],
        text: call.args[1],
      });
    case "setSnooze": {
      const value = call.args[1];
      if (!value || typeof value !== "object" || !("until" in value))
        throw new Error("Choose a snooze date or clear the snooze.");
      return decode(PullRequestsCommand, {
        ...row,
        action: "snooze",
        expectedVersion: call.args[2],
        snooze:
          value.until === null
            ? null
            : { ...value, headOid: "headOid" in value ? value.headOid : pr.headOid },
      });
    }
    case "markReviewed":
    case "inspect":
      return decode(PullRequestsCommand, {
        ...row,
        action: "review",
        expectedVersion: call.args[2],
        baseline: call.method === "inspect" ? "inspected" : "reviewed",
        headOid: call.args[1],
      });
    default:
      throw new Error("Unknown PR inbox operation.");
  }
}
