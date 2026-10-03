import type { Actor, PlanCommand, PlanEvent, PlanSnapshot, Presence } from "../contracts.ts";
import { planApi } from "../contracts.ts";
import { BrowserStore } from "./storage.ts";

export type SyncView = {
  snapshot: PlanSnapshot | null;
  status: string;
  connected: boolean;
  storageError: boolean;
  commentReady: boolean;
};
export class PlanSync {
  private store: BrowserStore | null = null;
  private serial: Promise<void> = Promise.resolve();
  private stream: { close: () => void } | null = null;
  private draining = false;
  private state: SyncView = {
    snapshot: null,
    status: "Opening local database…",
    connected: false,
    storageError: false,
    commentReady: false,
  };
  private position = { elementId: null as string | null, x: -1, y: -1 };
  private reconnecting = false;
  private incoming: PlanEvent[] = [];
  private incomingScheduled = false;
  private presenceSending = 0;
  private presencePending = false;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceStarted = 0;
  private presenceSequence = 0;

  constructor(
    readonly name: string,
    readonly editor: string,
    public actor: Actor,
    private changed: (view: SyncView) => void,
    private presence: (people: Presence[]) => void,
  ) {
    try {
      const stored = Number(sessionStorage.getItem(`scope-plan-presence:${editor}`));
      if (Number.isSafeInteger(stored) && stored >= 0) this.presenceSequence = stored;
    } catch {
      /* Without session storage, the editor identity is new on reload. */
    }
  }

  async start() {
    try {
      this.store = await BrowserStore.open(this.name, this.editor);
      await this.refresh();
      await this.store.initialize(await this.getSnapshot());
      await this.refresh();
      await this.connect();
    } catch (error) {
      this.state.status = this.store
        ? "Offline · cached plan available"
        : `Local storage unavailable · ${message(error)}`;
      this.state.storageError = !this.store;
      if (!this.store) {
        try {
          this.state.snapshot = await this.getSnapshot();
        } catch {
          /* Keep the storage explanation. */
        }
      }
      this.emit();
    }
    setInterval(() => {
      void this.reconnect();
      void this.drain();
    }, 1500);
    setInterval(() => {
      void this.sendPresence();
    }, 2500);
    window.addEventListener("online", () => {
      void this.reconnect();
    });
  }
  private emit() {
    this.changed({ ...this.state });
  }
  private async refresh() {
    if (!this.store) return;
    const saved = await this.store.read();
    this.state.snapshot = saved.snapshot;
    this.state.commentReady = saved.commentReady;
    const pending = await this.store.pending();
    const rejected = pending.find(
      (item) => item.editor === this.editor && item.status === "rejected",
    );
    this.state.status = rejected
      ? `Rejected comment · ${rejected.rejection?.message ?? "Review rejected comments"}`
      : pending.some((item) => item.status === "pending")
        ? "Saved locally · waiting for server"
        : "Comments saved";
    if (!saved.snapshot || !saved.commentReady) this.state.status = "Opening plan…";
    this.emit();
  }
  private enqueue(work: () => Promise<void>) {
    this.serial = this.serial.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await work();
          return;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("database did not respond") &&
            attempt < 2
          ) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            continue;
          }
          this.state.storageError = true;
          this.state.status = `Comment save failed · retry local storage · ${message(error)}`;
          this.stream?.close();
          this.stream = null;
          this.state.connected = false;
          this.emit();
          return;
        }
      }
    });
    return this.serial;
  }
  async retryStorage() {
    try {
      this.store = await BrowserStore.open(this.name, this.editor);
      if (!(await this.store.read()).commentReady)
        await this.store.initialize(await this.getSnapshot());
      this.state.storageError = false;
      await this.refresh();
      await this.connect();
      await this.drain();
    } catch (error) {
      this.state.status = `Local storage unavailable · ${message(error)}`;
      this.emit();
    }
  }
  async command(command: PlanCommand) {
    if (command.kind === "html") throw new Error("Browser readers cannot submit HTML.");
    if (this.state.storageError || !this.state.commentReady)
      throw new Error("Local comment storage is unavailable.");
    this.state.status = "Saving comment locally…";
    this.emit();
    await this.enqueue(async () => {
      await this.store!.queueCommand(command);
      await this.refresh();
    });
    if (this.state.storageError)
      throw new Error("Comment remains in the composer because local persistence failed.");
    void this.drain();
  }
  async archive() {
    return this.store ? this.store.archive() : null;
  }
  async rejectedChanges() {
    return this.store
      ? (await this.store.pending()).filter((item) => item.status === "rejected")
      : [];
  }
  async dismissRejected(requestId: string, replacement?: PlanCommand) {
    await this.enqueue(async () => {
      await this.store!.dismissRejected(requestId, replacement);
      await this.refresh();
    });
    if (this.state.storageError)
      throw new Error("Local recovery was not confirmed. Retry the same comment.");
    await this.drain();
  }
  private async getSnapshot(): Promise<PlanSnapshot> {
    const response = await fetch(planApi(this.name), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return response.json();
  }
  private async connect() {
    if (!this.store || this.stream || this.state.storageError) return;
    this.stream = this.store.watchEvents((message) => {
      if (message.event === "plan") {
        this.incoming.push(message.data);
        this.flushEvents();
      } else if (message.event === "presence") this.presence(message.data);
      else if (message.event === "connection") {
        this.state.connected = message.data;
        this.emit();
        if (message.data) void this.sendPresence();
      } else {
        this.state.storageError = true;
        this.state.status = `Comment storage unavailable · ${message.data}`;
        this.state.connected = false;
        this.stream?.close();
        this.stream = null;
        this.emit();
      }
    });
  }
  private flushEvents() {
    if (this.incomingScheduled) return;
    this.incomingScheduled = true;
    setTimeout(() => {
      let batch: PlanEvent[] | null = null;
      void this.enqueue(async () => {
        batch ??= this.incoming.splice(0);
        const latest = batch.at(-1);
        if (latest) {
          await this.store!.accept(
            latest.snapshot,
            batch.map((item) => item.requestId),
          );
          await this.refresh();
        }
      }).then(() => {
        this.incomingScheduled = false;
        if (this.incoming.length) this.flushEvents();
      });
    }, 25);
  }
  private async reconnect() {
    if (this.reconnecting || !this.store || this.state.storageError) return;
    this.reconnecting = true;
    try {
      if (!this.stream) {
        const snapshot = await this.getSnapshot();
        await this.enqueue(async () => {
          await this.store!.initialize(snapshot);
          await this.refresh();
        });
        await this.connect();
      }
    } catch {
      this.state.connected = false;
      this.emit();
    } finally {
      this.reconnecting = false;
    }
  }
  private async drain() {
    if (this.draining || !this.store || this.state.storageError || !this.state.commentReady) return;
    this.draining = true;
    try {
      for (const item of await this.store.pending()) {
        if (item.status !== "pending" || item.command.kind === "html") continue;
        const response = await fetch(`${planApi(this.name)}/commands`, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.command),
        });
        const body = await response.json().catch((error: unknown) => {
          if ([400, 413, 422].includes(response.status)) return {};
          throw error;
        });
        const receipt = body && typeof body === "object" && !Array.isArray(body) ? body : {};
        if ([400, 413, 422].includes(response.status)) {
          await this.enqueue(async () => {
            await this.store!.reject(
              item.requestId,
              response.status,
              String(receipt.message ?? receipt.error ?? `Server returned ${response.status}`),
            );
            await this.refresh();
          });
        } else if (response.ok) {
          await this.enqueue(async () => {
            await this.store!.accept(receipt.snapshot, item.requestId);
            await this.refresh();
          });
        } else
          throw new Error(receipt.message ?? receipt.error ?? `Server returned ${response.status}`);
        if (this.state.storageError) break;
      }
    } catch {
      this.state.connected = false;
      if (!this.state.storageError) this.state.status = "Saved locally · waiting for server";
      this.emit();
    } finally {
      this.draining = false;
    }
  }

  selectActor(actor: Actor) {
    this.actor = actor;
    void this.sendPresence();
  }

  cursor(elementId: string | null, x: number, y: number) {
    this.position = { elementId, x, y };
    void this.sendPresence();
  }
  private async sendPresence() {
    this.presencePending = true;
    if (this.presenceSending >= 2) {
      return;
    }
    if (this.presenceTimer !== undefined) return;
    const wait = 33 - (performance.now() - this.presenceStarted);
    if (wait > 0) {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = undefined;
        void this.sendPresence();
      }, wait);
      return;
    }
    this.presenceSending++;
    this.presencePending = false;
    this.presenceStarted = performance.now();
    const sequence = ++this.presenceSequence;
    try {
      sessionStorage.setItem(`scope-plan-presence:${this.editor}`, String(sequence));
    } catch {
      /* Presence stays usable in memory when tab storage is unavailable. */
    }
    try {
      const response = await fetch(`${planApi(this.name)}/presence`, {
        method: "POST",
        signal: AbortSignal.timeout(500),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.editor,
          actor: this.actor,
          sequence,
          ...this.position,
        }),
      });
      await response.arrayBuffer();
    } catch {
      /* Presence can disappear while offline without affecting durable edits. */
      this.presencePending = true;
      if (this.presenceTimer === undefined)
        this.presenceTimer = setTimeout(() => {
          this.presenceTimer = undefined;
          void this.sendPresence();
        }, 250);
    } finally {
      this.presenceSending--;
      if (this.presencePending) void this.sendPresence();
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
