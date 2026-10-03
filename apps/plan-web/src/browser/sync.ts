import type { Actor, PlanCommand, PlanEvent, PlanSnapshot, Presence } from "../contracts.ts";
import { planApi } from "../contracts.ts";
import { BrowserStore, type Draft } from "./storage.ts";

export type SyncView = {
  snapshot: PlanSnapshot | null;
  draft: Draft | null;
  status: string;
  connected: boolean;
  storageError: boolean;
  restoring: boolean;
};
export class PlanSync {
  private store: BrowserStore | null = null;
  private serial: Promise<void> = Promise.resolve();
  private stream: { close: () => void } | null = null;
  private draining = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private state: SyncView = {
    snapshot: null,
    draft: null,
    status: "Opening local database…",
    connected: false,
    storageError: false,
    restoring: false,
  };
  private position = { elementId: null as string | null, x: 0, y: 0 };
  private reconnecting = false;
  private incoming: PlanEvent[] = [];
  private incomingScheduled = false;
  private pendingDraft: { draft: Draft; previousHtml: string | undefined } | null = null;
  private draftFlush: Promise<void> | null = null;
  private persistedGeneration = -1;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceSending = false;
  private presencePending = false;
  private pendingRestore: (() => Promise<void>) | null = null;

  constructor(
    readonly name: string,
    readonly editor: string,
    public actor: Actor,
    private changed: (view: SyncView) => void,
    private presence: (people: Presence[]) => void,
  ) {}

  async start() {
    try {
      this.store = await BrowserStore.open(this.name, this.editor);
      await this.refresh();
      const snapshot = await this.getSnapshot();
      await this.store.initialize(snapshot);
      await this.refresh();
      await this.connect();
    } catch (error) {
      this.state.status = this.store
        ? "Offline · local draft available"
        : `Local storage unavailable · ${message(error)}`;
      this.state.storageError = !this.store;
      if (!this.store) {
        try {
          this.state.snapshot = await this.getSnapshot();
        } catch {
          /* The storage explanation remains useful when the server is also offline. */
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
    this.persistedGeneration = saved.draft?.generation ?? -1;
    this.state.snapshot = saved.snapshot;
    if (saved.draft && (!this.state.draft || saved.draft.generation >= this.state.draft.generation))
      this.state.draft = saved.draft;
    const pending = await this.store.pending();
    const own = pending.filter((item) => item.editor === this.editor);
    const rejected = own.find(
      (item) =>
        item.status === "rejected" &&
        (item.command.kind !== "html" || item.generation === this.state.draft?.generation),
    );
    this.state.status = rejected
      ? `Rejected by server · ${rejected.rejection?.message ?? "Review rejected changes"}`
      : this.state.draft?.dirty &&
          this.state.draft.generation === this.state.draft.rejectedGeneration
        ? "Rejected HTML preserved · edit before retrying"
        : this.state.draft?.conflict
          ? "Conflict · local HTML preserved"
          : own.some((item) => item.status !== "rejected") || this.state.draft?.dirty
            ? "Saved locally · waiting for server"
            : "Saved to server";
    if (this.state.draft && this.state.draft.generation > this.persistedGeneration)
      this.state.status = "Saving locally…";
    if (!this.state.snapshot || !this.state.draft) this.state.status = "Opening plan…";
    if (this.state.restoring) this.state.status = "Restoring HTML…";
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
          this.state.status = `Local save failed · export your HTML · ${message(error)}`;
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

  edit(html: string) {
    if (this.state.restoring) return;
    const previous = this.state.draft;
    const snapshot = this.state.snapshot;
    const draft: Draft = {
      html,
      generation: (previous?.generation ?? 0) + 1,
      baseHtml: previous?.baseHtml ?? snapshot?.html ?? "",
      baseHtmlRevision: previous?.baseHtmlRevision ?? snapshot?.htmlRevision ?? 0,
      dirty: true,
      conflict: previous?.conflict ?? null,
      actor: this.actor,
    };
    this.state.draft = draft;
    this.state.status = "Saving locally…";
    this.emit();
    this.pendingDraft = { draft, previousHtml: this.pendingDraft?.previousHtml ?? previous?.html };
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      void this.persistDraft();
    }, 150);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.save();
    }, 450);
  }

  private async persistDraft() {
    clearTimeout(this.draftTimer);
    if (this.draftFlush) {
      await this.draftFlush;
      return;
    }
    if (!this.pendingDraft) return;
    let pending: { draft: Draft; previousHtml: string | undefined } | null = null;
    this.draftFlush = this.enqueue(async () => {
      if (!pending) {
        pending = this.pendingDraft;
        this.pendingDraft = null;
      }
      if (!pending) return;
      if (!this.store) throw new Error("Database is unavailable");
      await this.store.saveDraft(pending.draft, pending.previousHtml);
      this.state.storageError = false;
      await this.refresh();
    });
    await this.draftFlush;
    this.draftFlush = null;
    if (this.pendingDraft)
      this.draftTimer = setTimeout(() => {
        void this.persistDraft();
      }, 150);
  }

  async save() {
    if (this.state.restoring) return;
    while (this.pendingDraft || this.draftFlush) await this.persistDraft();
    if (this.state.storageError) return;
    const requestId = crypto.randomUUID();
    await this.enqueue(async () => {
      if (!this.store) throw new Error("Database is unavailable");
      await this.store.queueHtml(this.actor, requestId);
      await this.refresh();
    });
    await this.drain();
  }

  async retryStorage() {
    if (!this.store || this.state.storageError) {
      try {
        this.store = await BrowserStore.open(this.name, this.editor);
      } catch (error) {
        this.state.status = `Local storage unavailable · ${message(error)}`;
        this.emit();
        return;
      }
    }
    const restore = this.pendingRestore;
    if (restore) {
      const draft = this.state.draft;
      await this.enqueue(async () => {
        if (draft) await this.store!.saveDraft(draft);
        await this.refresh();
        this.state.storageError = false;
      });
      if (this.state.storageError) return;
      await this.restoreDraft(restore);
      if (this.state.storageError) return;
      await this.reconnect();
      await this.save();
      return;
    }
    const draft = this.state.draft;
    await this.enqueue(async () => {
      if (draft) await this.store!.saveDraft(draft);
      this.state.storageError = false;
      await this.refresh();
    });
    await this.reconnect();
    await this.save();
  }

  async command(command: PlanCommand) {
    if (this.state.storageError) throw new Error("Retry local save before sending a comment.");
    this.state.status = "Saving locally…";
    this.emit();
    await this.enqueue(async () => {
      if (!this.store) throw new Error("Database is unavailable");
      await this.store.queueCommand(command);
      await this.refresh();
    });
    if (this.state.storageError)
      throw new Error("Comment remains in the editor because local persistence failed.");
    await this.drain();
  }

  async savedDrafts() {
    return this.store ? this.store.drafts() : [];
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
      throw new Error("Local recovery was not confirmed. Retry the same change.");
    await this.drain();
  }
  async restoreRejected(requestId: string) {
    if (this.state.restoring) return;
    const operationId = crypto.randomUUID();
    const actor = this.actor;
    await this.restoreDraft(() => this.store!.restoreRejected(requestId, actor, operationId));
  }

  private async restoreDraft(work: () => Promise<void>) {
    this.pendingRestore = work;
    this.state.restoring = true;
    this.state.status = "Restoring HTML…";
    this.emit();
    try {
      while (this.pendingDraft || this.draftFlush) await this.persistDraft();
      if (this.state.storageError) return;
      await this.enqueue(async () => {
        await work();
        await this.refresh();
        this.state.storageError = false;
      });
    } finally {
      if (this.state.storageError) {
        // The restore may have committed despite a lost reply; reconcile before accepting typing.
        this.emit();
      } else {
        this.pendingRestore = null;
        this.state.restoring = false;
        await this.refresh();
      }
    }
  }

  async recover(editor: string) {
    if (this.state.restoring) return;
    const operationId = crypto.randomUUID();
    const actor = this.actor;
    await this.restoreDraft(() => this.store!.recover(editor, actor, operationId));
    if (this.state.storageError) return;
    await this.save();
  }

  async resolve(html: string) {
    if (this.state.restoring) return;
    while (this.pendingDraft || this.draftFlush) await this.persistDraft();
    const snapshot = this.state.draft?.conflict ?? this.state.snapshot;
    if (!snapshot) return;
    const draft: Draft = {
      html,
      generation: (this.state.draft?.generation ?? 0) + 1,
      baseHtml: snapshot.html,
      baseHtmlRevision: snapshot.htmlRevision,
      dirty: html !== snapshot.html,
      conflict: null,
      actor: this.actor,
    };
    this.state.draft = draft;
    await this.enqueue(async () => {
      await this.store!.resolve(draft);
      await this.refresh();
    });
    await this.save();
  }

  private async getSnapshot(): Promise<PlanSnapshot> {
    const response = await fetch(planApi(this.name), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return response.json();
  }

  private async connect() {
    if (!this.store || this.stream) return;
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
        this.state.status = `Local save failed · export your HTML · ${message.data}`;
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
        if (this.state.draft?.dirty && !this.state.draft.conflict) {
          clearTimeout(this.saveTimer);
          this.saveTimer = setTimeout(() => {
            void this.save();
          }, 50);
        }
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
    if (this.draining || !this.store || this.state.storageError) return;
    this.draining = true;
    try {
      const pending = await this.store.pending();
      for (const item of pending) {
        if (item.status !== "pending") continue;
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
          if (this.state.storageError) break;
          continue;
        }
        if (response.status === 409) {
          await this.enqueue(async () => {
            await this.store!.conflict(item.requestId, receipt.snapshot);
            await this.refresh();
          });
        } else if (response.ok) {
          await this.enqueue(async () => {
            await this.store!.accept(receipt.snapshot, item.requestId);
            await this.refresh();
          });
        } else
          throw new Error(receipt.message ?? receipt.error ?? `Server returned ${response.status}`);
      }
      const nextRequestId = crypto.randomUUID();
      await this.enqueue(async () => {
        await this.store!.queueHtml(this.actor, nextRequestId);
        await this.refresh();
      });
    } catch {
      this.state.connected = false;
      if (!this.state.storageError && !this.state.draft?.conflict)
        this.state.status =
          this.state.draft && this.state.draft.generation > this.persistedGeneration
            ? "Saving locally…"
            : "Saved locally · waiting for server";
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
    if (this.presenceSending) {
      this.presencePending = true;
      return;
    }
    this.presenceSending = true;
    this.presencePending = false;
    try {
      const response = await fetch(`${planApi(this.name)}/presence`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.editor, actor: this.actor, ...this.position }),
      });
      await response.arrayBuffer();
    } catch {
      /* Presence can disappear while offline without affecting durable edits. */
    } finally {
      this.presenceSending = false;
      if (this.presencePending)
        setTimeout(() => {
          void this.sendPresence();
        }, 100);
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
