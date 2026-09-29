import { decode } from "@irudd-scope/protocol";
import {
  DiagramCommandRequest,
  type DiagramCommandResult,
  type HostedDiagramCommand,
} from "./commands.ts";

type Handler = (
  command: HostedDiagramCommand,
  signal: AbortSignal,
) => Promise<DiagramCommandResult>;
const views = new Map<string, Handler>();
const opening = new Map<string, Set<(handler: Handler) => void>>();

export function registerDiagramCommands(id: string, handler: Handler) {
  views.set(id, handler);
  for (const ready of opening.get(id) ?? []) ready(handler);
  return () => {
    if (views.get(id) === handler) views.delete(id);
  };
}

function waitForDiagram(id: string, signal: AbortSignal): Promise<Handler> {
  const current = views.get(id);
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const entries = opening.get(id) ?? new Set();
    const cleanup = () => {
      entries.delete(ready);
      if (!entries.size) opening.delete(id);
      signal.removeEventListener("abort", aborted);
    };
    const ready = (handler: Handler) => {
      cleanup();
      resolve(handler);
    };
    const aborted = () => {
      cleanup();
      reject(new Error("The diagram did not finish opening before the request ended."));
    };
    entries.add(ready);
    opening.set(id, entries);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function startDiagramCommands() {
  const active = new Map<string, AbortController>();
  window.scope.onDiagramCommandCancel((id) => active.get(id)?.abort());
  window.scope.onDiagramCommand(async (input) => {
    const { requestId, expires, command } = decode(DiagramCommandRequest, input);
    const controller = new AbortController();
    active.set(requestId, controller);
    if (Date.now() >= expires) controller.abort();
    const timer = setTimeout(() => controller.abort(), Math.max(0, expires - Date.now()));
    try {
      let result: DiagramCommandResult;
      if (command.action === "create") {
        const [{ renderScene }, { applyOperations }, { emptyScene }, { serializeAsJSON }] =
          await Promise.all([
            import("./canvas.ts"),
            import("./scene.ts"),
            import("./contract.ts"),
            import("@excalidraw/excalidraw"),
          ]);
        controller.signal.throwIfAborted();
        const elements = renderScene(applyOperations(emptyScene(), command.operations));
        result = { type: "document", content: serializeAsJSON(elements, {}, {}, "local") };
      } else {
        const handler =
          command.action === "sync"
            ? await waitForDiagram(command.id, controller.signal)
            : views.get(command.id);
        if (!handler)
          throw new Error("Open this diagram tab in Scope and wait for it to load, then retry.");
        result = await handler(command, controller.signal);
      }
      controller.signal.throwIfAborted();
      await window.scope.diagramCommandResult({ requestId, result });
    } catch (error) {
      await window.scope.diagramCommandResult({
        requestId,
        error: (error instanceof Error ? error.message : "Diagram command failed.").slice(0, 2000),
      });
    } finally {
      clearTimeout(timer);
      active.delete(requestId);
    }
  });
}
