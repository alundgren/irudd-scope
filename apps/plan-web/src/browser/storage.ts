import DatabaseWorker from "./database-worker.ts?sharedworker";
import type { Actor, PlanCommand, PlanSnapshot } from "../contracts.ts";
import type { Draft, Pending, LocalDatabase, EditorRow } from "./local-database.ts";
import type { StreamMessage, StreamRequest } from "./event-stream.ts";
export type { Draft, Pending } from "./local-database.ts";

export type StoreOperation =
  | "read"
  | "initialize"
  | "saveDraft"
  | "queueHtml"
  | "queueCommand"
  | "pending"
  | "accept"
  | "conflict"
  | "resolve"
  | "drafts"
  | "recover"
  | "reject"
  | "dismissRejected"
  | "restoreRejected";
export type StoreRequest = {
  id: number;
  plan: string;
  editor: string;
  operation: StoreOperation;
  args: unknown[];
};
type StoreResponse = { id: number; result?: unknown; error?: string };

export class BrowserStore {
  private counter = 0;
  private listener: ((message: StreamMessage) => void) | null = null;
  private calls = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(
    private worker: SharedWorker,
    readonly plan: string,
    readonly editor: string,
  ) {
    worker.port.onmessage = (event: MessageEvent<StoreResponse | StreamMessage>) => {
      const response = event.data;
      if ("kind" in response) {
        this.listener?.(response);
        return;
      }
      const pending = this.calls.get(response.id);
      if (!pending) return;
      this.calls.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.result);
    };
    worker.onerror = () => {
      for (const pending of this.calls.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Browser database worker stopped. Retry local save."));
      }
      this.calls.clear();
      this.listener?.({
        kind: "stream",
        event: "error",
        data: "Browser database worker stopped. Retry local save.",
      });
    };
    worker.port.start();
  }

  static async open(plan: string, editor: string) {
    if (!globalThis.isSecureContext || !navigator.locks || typeof SharedWorker === "undefined")
      throw new Error(
        "Open through HTTPS or localhost in a browser with SharedWorker support for durable editing.",
      );
    const worker = new DatabaseWorker({ name: "scope-plan-web-v1" });
    const store = new BrowserStore(worker, plan, editor);
    await store.read();
    return store;
  }

  private call<T>(operation: StoreOperation, args: unknown[]): Promise<T> {
    const id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(
          new Error(
            "Browser database did not respond. Retry local save; existing command IDs will be reconciled.",
          ),
        );
      }, 15_000);
      this.calls.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.worker.port.postMessage({
          id,
          plan: this.plan,
          editor: this.editor,
          operation,
          args,
        } satisfies StoreRequest);
      } catch (error) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  read() {
    return this.call<Awaited<ReturnType<LocalDatabase["read"]>>>("read", []);
  }
  initialize(snapshot: PlanSnapshot) {
    return this.call<void>("initialize", [snapshot]);
  }
  saveDraft(draft: Draft, previousHtml?: string) {
    return this.call<void>("saveDraft", [draft, previousHtml]);
  }
  queueHtml(actor: Actor, requestId: string) {
    return this.call<void>("queueHtml", [actor, requestId]);
  }
  queueCommand(command: PlanCommand) {
    return this.call<void>("queueCommand", [command]);
  }
  pending() {
    return this.call<Pending[]>("pending", []);
  }
  accept(snapshot: PlanSnapshot, requestId?: string | string[]) {
    return this.call<void>("accept", [snapshot, requestId]);
  }
  conflict(requestId: string, snapshot: PlanSnapshot) {
    return this.call<void>("conflict", [requestId, snapshot]);
  }
  resolve(draft: Draft) {
    return this.call<void>("resolve", [draft]);
  }
  drafts() {
    return this.call<EditorRow[]>("drafts", []);
  }
  recover(editor: string, actor: Actor) {
    return this.call<void>("recover", [editor, actor]);
  }
  reject(requestId: string, status: number, message: string) {
    return this.call<void>("reject", [requestId, status, message]);
  }
  dismissRejected(requestId: string, replacement?: PlanCommand) {
    return this.call<void>("dismissRejected", [requestId, replacement]);
  }
  restoreRejected(requestId: string, actor: Actor, operationId: string) {
    return this.call<void>("restoreRejected", [requestId, actor, operationId]);
  }
  watchEvents(listener: (message: StreamMessage) => void) {
    this.listener = listener;
    const watch = () => {
      try {
        this.worker.port.postMessage({ kind: "watch", plan: this.plan } satisfies StreamRequest);
      } catch {
        this.listener?.({
          kind: "stream",
          event: "error",
          data: "Browser database worker stopped. Retry local save.",
        });
      }
    };
    watch();
    const timer = setInterval(watch, 5000);
    document.addEventListener("visibilitychange", watch);
    const close = () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", watch);
      this.listener = null;
      try {
        this.worker.port.postMessage({ kind: "unwatch", plan: this.plan } satisfies StreamRequest);
      } catch {
        /* Worker termination preserves previously committed subscriptions and drafts. */
      }
    };
    window.addEventListener(
      "pagehide",
      () => {
        close();
        this.worker.port.close();
      },
      { once: true },
    );
    return { close };
  }
}
