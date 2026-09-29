import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import { ArtifactId, ScopeError, decode } from "@irudd-scope/protocol";
import {
  AgentHistory,
  DiagramAgentCommand,
  type DiagramAgentReply,
  type DiagramAgentStatus,
} from "@irudd-scope/protocol/diagram-agent";
import type { DiagramCommand, DiagramReply } from "@irudd-scope/protocol/diagram";

export const TabAgentRequest = Schema.Struct({
  id: ArtifactId,
  intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
  history: AgentHistory,
});
type TabResult = { message: string };
type Connection = {
  id: string;
  tabId?: string;
  name: string;
  requestId: string;
  token: string;
  phase: "waiting" | "working";
  ready: boolean;
  expires: number;
  delivering: boolean;
  replying: boolean;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  deliver: (result: DiagramAgentReply) => void;
  failWait: (error: Error) => void;
  result?: { resolve: (result: TabResult) => void; reject: (error: Error) => void };
};

export function connectedDiagramAgents(
  diagram: (command: DiagramCommand, signal: AbortSignal) => Promise<DiagramReply>,
  changed: (status: DiagramAgentStatus) => void,
  tabOwner: (id: string) => Promise<string | undefined>,
) {
  const connections = new Map<string, Connection>();
  function status(id: string): DiagramAgentStatus {
    const connection = connections.get(id);
    return {
      id,
      phase: connection?.ready ? connection.phase : "disconnected",
      name: connection?.name ?? "",
    };
  }
  function finish(connection: Connection, error?: Error) {
    if (connections.get(connection.id) !== connection) return;
    connections.delete(connection.id);
    clearTimeout(connection.timer);
    connection.controller.abort();
    if (error) {
      connection.failWait(error);
      connection.result?.reject(error);
    } else connection.deliver({ type: "idle" });
    changed(status(connection.id));
  }
  function cancel(id: string) {
    const connection = connections.get(id);
    if (connection)
      finish(
        connection,
        new ScopeError(
          409,
          "The connected-agent request ended. Connect again to receive another request.",
        ),
      );
  }
  async function wait(
    command: Extract<DiagramAgentCommand, { action: "wait" }>,
    signal: AbortSignal,
  ) {
    if (connections.has(command.id))
      throw new ScopeError(409, "An agent is already connected to this diagram.");
    if (connections.size >= 4)
      throw new ScopeError(503, "Four diagram agents are already connected.");
    signal.throwIfAborted();
    let connection: Connection;
    const result = new Promise<DiagramAgentReply>((resolve, reject) => {
      connection = {
        id: command.id,
        name: command.name,
        requestId: randomUUID(),
        token: randomBytes(32).toString("hex"),
        phase: "waiting",
        ready: false,
        expires: Date.now() + 20_000,
        delivering: false,
        replying: false,
        controller: new AbortController(),
        timer: setTimeout(() => finish(connection), 20_000),
        deliver: resolve,
        failWait: reject,
      };
      connections.set(command.id, connection);
    });
    void result.catch(() => {});
    const disconnected = () => {
      if (
        connections.get(command.id) === connection &&
        (connection.phase === "waiting" || connection.delivering)
      )
        cancel(command.id);
    };
    signal.addEventListener("abort", disconnected, { once: true });
    try {
      connection!.tabId = await tabOwner(command.id);
      if (!connection!.tabId)
        throw new ScopeError(409, "Open this diagram tab before connecting an agent.");
      // The initial read proves that this tab is loaded before advertising a waiting agent.
      const initial = await diagram(
        { action: "read", id: command.id },
        AbortSignal.any([signal, connection!.controller.signal]),
      );
      if (initial.type !== "snapshot") throw new Error("Expected a diagram snapshot.");
      if ((await tabOwner(command.id)) !== connection!.tabId)
        throw new ScopeError(409, "This tab closed while the agent was connecting.");
      connection!.controller.signal.throwIfAborted();
      connection!.ready = true;
      changed(status(command.id));
    } catch (error) {
      finish(
        connection!,
        error instanceof Error ? error : new Error("The diagram is unavailable."),
      );
    }
    return result.finally(() => signal.removeEventListener("abort", disconnected));
  }
  async function request(input: unknown): Promise<TabResult> {
    const { id, intent, history } = decode(TabAgentRequest, input);
    const connection = connections.get(id);
    if (
      !connection ||
      Date.now() >= connection.expires ||
      !connection.ready ||
      connection.phase !== "waiting" ||
      connection.delivering
    )
      throw new Error("No agent is waiting. Ask your publishing agent to connect to this tab.");
    connection.delivering = true;
    try {
      const read = await diagram({ action: "read", id }, connection.controller.signal);
      if (read.type !== "snapshot") throw new Error("Expected a diagram snapshot.");
      connection.controller.signal.throwIfAborted();
      const result = new Promise<TabResult>((resolve, reject) => {
        connection.result = { resolve, reject };
      });
      clearTimeout(connection.timer);
      connection.timer = setTimeout(
        () =>
          finish(
            connection,
            new Error(
              "The agent did not reply within five minutes. Your canvas was kept. Connect again and retry.",
            ),
          ),
        300_000,
      );
      connection.expires = Date.now() + 300_000;
      connection.phase = "working";
      connection.delivering = false;
      connection.deliver({
        type: "request",
        id,
        requestId: connection.requestId,
        token: connection.token,
        intent,
        diagram: read.diagram,
        history,
      });
      changed(status(id));
      return result;
    } catch (error) {
      finish(connection, error instanceof Error ? error : new Error("Could not send the request."));
      throw error;
    }
  }
  async function run(input: DiagramAgentCommand, signal: AbortSignal): Promise<DiagramAgentReply> {
    const command = decode(DiagramAgentCommand, input);
    if (command.action === "wait") return wait(command, signal);
    const connection = connections.get(command.id);
    if (
      !connection ||
      Date.now() >= connection.expires ||
      connection.phase !== "working" ||
      connection.requestId !== command.requestId ||
      !timingSafeEqual(Buffer.from(command.token), Buffer.from(connection.token))
    )
      throw new ScopeError(409, "This agent request has expired or its credential is invalid.");
    if (command.action === "release") {
      cancel(command.id);
      return { type: "released" };
    }
    if (connection.replying) throw new ScopeError(409, "A reply is already being applied.");
    connection.replying = true;
    try {
      const combined = AbortSignal.any([signal, connection.controller.signal]);
      const result = await diagram(
        command.operations.length
          ? {
              action: "apply",
              id: command.id,
              snapshot: command.snapshot,
              operations: command.operations,
            }
          : { action: "read", id: command.id },
        combined,
      );
      combined.throwIfAborted();
      if (result.type !== "snapshot") throw new Error("Expected a diagram snapshot.");
      connection.result!.resolve({ message: command.message });
      finish(connection);
      return { type: "applied", diagram: result.diagram };
    } finally {
      connection.replying = false;
    }
  }
  return {
    run,
    request,
    status,
    cancel,
    cancelTabs: (ids: string[]) => {
      for (const connection of connections.values())
        if (connection.tabId && ids.includes(connection.tabId))
          finish(connection, new ScopeError(409, "This diagram tab closed."));
    },
    close: () => {
      for (const id of connections.keys()) cancel(id);
    },
  };
}
