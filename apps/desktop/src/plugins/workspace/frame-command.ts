import { decode } from "@irudd-scope/protocol";
import { WorkspaceCommand, type WorkspaceSnapshot } from "@irudd-scope/protocol/workspace";
import type { FrameIdentity } from "./frame-sdk.ts";

export type FrameCall = FrameIdentity & { id: string; method: string; args: unknown[] };

export function frameCommand(
  call: FrameCall,
  snapshot: WorkspaceSnapshot,
  tabId: string,
): WorkspaceCommand {
  const base = { name: snapshot.artifact.name!, requestId: crypto.randomUUID(), tabId };
  if (
    ["readNodeState", "setNodeState", "patchNodeState", "deleteNodeState"].includes(call.method)
  ) {
    return decode(WorkspaceCommand, {
      ...(call.method === "readNodeState" ? { name: base.name, tabId } : base),
      nodeId: call.args[0],
      action:
        call.method === "readNodeState"
          ? "node-state-read"
          : call.method === "setNodeState"
            ? "node-state-set"
            : call.method === "patchNodeState"
              ? "node-state-patch"
              : "node-state-delete",
      ...(call.method === "readNodeState"
        ? {}
        : {
            expectedVersion: call.args[2],
            [call.method === "deleteNodeState" ? "keys" : "value"]: call.args[1],
          }),
    });
  }
  if (call.method === "readState") return { name: base.name, action: "read" };
  if (call.method === "setState" || call.method === "patchState")
    return decode(WorkspaceCommand, {
      ...base,
      action: call.method === "setState" ? "state-set" : "state-patch",
      value: call.args[0],
      expectedVersion: call.args[1],
    });
  if (call.method === "deleteState")
    return decode(WorkspaceCommand, {
      ...base,
      action: "state-delete",
      keys: call.args[0],
      expectedVersion: call.args[1],
    });
  if (call.method === "configure") {
    const input = call.args[0] as { repository?: unknown; board?: unknown } | undefined;
    return decode(WorkspaceCommand, {
      ...base,
      action: "configure",
      repository: input?.repository,
      ...(input && "board" in input ? { board: input.board } : {}),
    });
  }
  if (call.method === "sync") return { ...base, action: "sync" };
  if (call.method === "prDetail")
    return decode(WorkspaceCommand, {
      ...base,
      action: "pr-detail",
      nodeId: call.args[0],
      ...(call.args[1] === undefined ? {} : { captured: call.args[1] }),
    });
  if (call.method === "loadPrDetails")
    return decode(WorkspaceCommand, { ...base, action: "pr-details", nodeIds: call.args[0] });
  if (call.method === "issueDetail")
    return decode(WorkspaceCommand, { ...base, action: "issue-detail", nodeId: call.args[0] });

  const nodeId = call.args[0];
  switch (call.method) {
    case "saveNote":
      return decode(WorkspaceCommand, {
        ...base,
        nodeId,
        action: "note",
        expectedVersion: call.args[2],
        text: call.args[1],
      });
    case "setSnooze": {
      const value = call.args[1];
      if (!value || typeof value !== "object" || !("until" in value))
        throw new Error("Choose a snooze date or clear the snooze.");
      const pr = snapshot.prs.find((row) => row.nodeId === nodeId);
      return decode(WorkspaceCommand, {
        ...base,
        nodeId,
        action: "snooze",
        expectedVersion: call.args[2],
        snooze:
          value.until === null
            ? null
            : {
                ...value,
                headOid: "headOid" in value ? value.headOid : (pr?.headOid ?? null),
              },
      });
    }
    case "markReviewed":
    case "inspect":
      return decode(WorkspaceCommand, {
        ...base,
        nodeId,
        action: "review",
        expectedVersion: call.args[2],
        baseline: call.method === "inspect" ? "inspected" : "reviewed",
        headOid: call.args[1],
      });
    default:
      throw new Error("Unknown workspace operation.");
  }
}
