import { expect, test, vi } from "vite-plus/test";
import { connectedDiagramAgents } from "../apps/desktop/src/plugins/diagram/connected-agent.ts";

test("idle connections and unanswered tab requests expire and discard their reply credentials", async () => {
  vi.useFakeTimers();
  const agents = connectedDiagramAgents(
    async (command) => ({
      type: "snapshot",
      diagram: {
        id: command.id,
        revision: 1,
        snapshot: "a".repeat(64),
        dirty: false,
        scene: { nodes: [], texts: [], connections: [], groups: [] },
        selectedIds: [],
        readOnly: [],
        omitted: 0,
      },
    }),
    () => {},
    async () => "test-tab",
  );
  try {
    const idle = agents.run(
      { action: "wait", id: "diagram", name: "Agent" },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(agents.status("diagram").phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await idle).toEqual({ type: "idle" });
    expect(agents.status("diagram").phase).toBe("disconnected");
    const waiting = agents.run(
      { action: "wait", id: "diagram", name: "Agent" },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1);
    const sent = agents.request({ id: "diagram", intent: "Explain this diagram.", history: [] });
    const timedOut = expect(sent).rejects.toThrow("five minutes");
    const request = await waiting;
    if (request.type !== "request") throw new Error("Expected a tab request.");
    expect(agents.status("diagram").phase).toBe("working");
    await vi.advanceTimersByTimeAsync(300_000);
    await timedOut;
    expect(agents.status("diagram").phase).toBe("disconnected");
    await expect(
      agents.run(
        {
          action: "reply",
          id: "diagram",
          requestId: request.requestId,
          token: request.token,
          snapshot: request.diagram.snapshot,
          message: "Late reply",
          operations: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("expired");
  } finally {
    agents.close();
    vi.useRealTimers();
  }
});

test("closing a tab invalidates its delivered request when an artifact ID is reused", async () => {
  let owner = "first-tab";
  const agents = connectedDiagramAgents(
    async (command) => ({
      type: "snapshot",
      diagram: {
        id: command.id,
        revision: 1,
        snapshot: "a".repeat(64),
        dirty: false,
        scene: { nodes: [], texts: [], connections: [], groups: [] },
        selectedIds: [],
        readOnly: [],
        omitted: 0,
      },
    }),
    () => {},
    async () => owner,
  );
  try {
    const waiting = agents.run(
      { action: "wait", id: "reused", name: "First agent" },
      new AbortController().signal,
    );
    await expect.poll(() => agents.status("reused").phase).toBe("waiting");
    const sent = agents.request({ id: "reused", intent: "Edit the old tab.", history: [] });
    const canceled = expect(sent).rejects.toThrow("tab closed");
    const request = await waiting;
    if (request.type !== "request") throw new Error("Expected a request.");
    agents.cancelTabs([owner]);
    await canceled;
    owner = "second-tab";
    const next = agents.run(
      { action: "wait", id: "reused", name: "Second agent" },
      new AbortController().signal,
    );
    const disconnected = expect(next).rejects.toThrow();
    await expect.poll(() => agents.status("reused").phase).toBe("waiting");
    agents.cancelTabs(["first-tab"]);
    expect(agents.status("reused").phase).toBe("waiting");
    await expect(
      agents.run(
        {
          action: "reply",
          id: "reused",
          requestId: request.requestId,
          token: request.token,
          snapshot: request.diagram.snapshot,
          message: "Old answer",
          operations: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("expired");
    agents.close();
    await disconnected;
  } finally {
    agents.close();
  }
});
