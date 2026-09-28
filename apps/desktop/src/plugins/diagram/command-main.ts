import { randomUUID } from "node:crypto";
import { ScopeError, decode } from "@irudd-scope/protocol";
import { DiagramReply } from "@irudd-scope/protocol/diagram";
import { DiagramSyncReply } from "@irudd-scope/protocol/diagram-sync";
import {
  DiagramCommandResponse,
  HostedDiagramCommand,
  type DiagramCommandRequest,
  type DiagramCommandResult,
} from "./commands.ts";
import type { ScopeClient } from "@irudd-scope/protocol/client";

export function diagramCommands(
  send: (request: DiagramCommandRequest) => void,
  cancel: (id: string) => void,
  client: ScopeClient,
) {
  const pending = new Map<
    string,
    {
      artifactId: string;
      resolve: (result: DiagramCommandResult) => void;
      reject: (error: Error) => void;
    }
  >();
  return {
    reply(input: unknown) {
      const response = decode(DiagramCommandResponse, input);
      const entry = pending.get(response.requestId);
      if (!entry) return;
      if (response.error) entry.reject(new ScopeError(409, response.error));
      else if (response.result) entry.resolve(response.result);
      else entry.reject(new ScopeError(502, "The diagram editor returned no result."));
    },
    cancelAll() {
      for (const [id, entry] of pending) {
        cancel(id);
        entry.reject(new ScopeError(503, "The diagram editor closed."));
      }
    },
    async run(input: HostedDiagramCommand, signal: AbortSignal): Promise<DiagramCommandResult> {
      const command = decode(HostedDiagramCommand, input);
      if (
        pending.size >= 4 ||
        [...pending.values()].some((entry) => entry.artifactId === command.id)
      )
        throw new ScopeError(409, "A diagram command is already running. Retry after it finishes.");
      const requestId = randomUUID();
      const timeout = AbortSignal.timeout(20_000);
      const combined = AbortSignal.any([signal, timeout]);
      let aborted: () => void = () => {};
      try {
        const result = await new Promise<DiagramCommandResult>((resolve, reject) => {
          pending.set(requestId, { artifactId: command.id, resolve, reject });
          aborted = () => {
            cancel(requestId);
            reject(
              new ScopeError(
                503,
                "Diagram command cancelled or timed out. Read the diagram before retrying.",
              ),
            );
          };
          combined.addEventListener("abort", aborted, { once: true });
          if (combined.aborted) aborted();
          else send({ requestId, command, expires: Date.now() + 20_000 });
        });
        combined.throwIfAborted();
        if (result.type === "document" && command.action === "create") {
          const artifact = await client.publish(
            command.id,
            {
              title: command.title,
              ...(command.name ? { name: command.name } : {}),
              kind: "excalidraw",
              mediaType: "application/vnd.excalidraw+json",
              fileName: `${command.id}.excalidraw`,
              expectedRevision: 0,
              ...(command.source ? { source: command.source } : {}),
            },
            new TextEncoder().encode(result.content),
            combined,
          );
          return { type: "created", artifact };
        }
        return command.action === "sync"
          ? decode(DiagramSyncReply, result)
          : decode(DiagramReply, result);
      } finally {
        combined.removeEventListener("abort", aborted);
        pending.delete(requestId);
      }
    },
  };
}
