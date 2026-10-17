import { useEffect, useState, useSyncExternalStore } from "react";
import {
  PROMPT_FIELDS,
  emptyPromptDocument,
  type PromptDocument,
  type PromptField,
  type PromptItem,
  type PromptReply,
  type PromptWorkspace,
} from "@irudd-scope/protocol/prompts";
import type { TabContext } from "../api.ts";
import type { PromptDesktopCommand, PromptDraft, PromptWrite } from "./contract.ts";

export class PromptFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function promptCommand(command: PromptDesktopCommand): Promise<PromptReply> {
  const result = await window.scope.promptCommand(command);
  if (!result.ok) throw new PromptFailure(result.status, result.message);
  return result.value;
}
export async function readPromptItem(id: string): Promise<PromptItem> {
  const reply = await promptCommand({ action: "read-item", id });
  if (reply.type !== "item") throw new Error("Could not read this library item. Retry.");
  return reply.item;
}
async function workspace(): Promise<PromptWorkspace> {
  const reply = await promptCommand({ action: "read-workspace" });
  if (reply.type !== "workspace") throw new Error("Could not read the current prompt. Retry.");
  return reply.workspace;
}
const copy = (document: PromptDocument): PromptDocument => structuredClone(document);
const same = (a: PromptDocument, b: PromptDocument) => JSON.stringify(a) === JSON.stringify(b);
export async function sanitizePrompt(document: PromptDocument): Promise<PromptDocument> {
  const entries = await Promise.all(
    PROMPT_FIELDS.map(async (field) => {
      const part = document.parts[field];
      if (!part.itemId) return [field, part] as const;
      try {
        await readPromptItem(part.itemId);
        return [field, part] as const;
      } catch (error) {
        if (error instanceof PromptFailure && error.status === 404)
          return [field, { ...part, itemId: null }] as const;
        throw error;
      }
    }),
  );
  const next = { ...document, parts: Object.fromEntries(entries) as PromptDocument["parts"] };
  return next;
}

type EditorSnapshot = {
  document: PromptDocument | null;
  status: "loading" | "saved" | "editing" | "saving" | "error" | "conflict";
  message: string;
  libraryEpoch: number;
};
class PromptEditor {
  private snapshot: EditorSnapshot = {
    document: null,
    status: "loading",
    message: "",
    libraryEpoch: 0,
  };
  private listeners = new Set<() => void>();
  private document = emptyPromptDocument();
  private revision = 0;
  private dirty = false;
  private pending?: PromptWrite;
  private conflict = false;
  private loaded = false;
  private editVersion = 0;
  private readVersion = 0;
  private inFlight?: Promise<void>;
  private draftWrites: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly tabId: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<EditorSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    const draft: PromptDraft | null =
      this.dirty || this.pending
        ? {
            revision: this.revision,
            document: copy(this.document),
            ...(this.pending && { pending: structuredClone(this.pending) }),
          }
        : null;
    const task = this.draftWrites
      .catch(() => {})
      .then(() => window.scope.savePromptDraft(this.tabId, draft));
    this.draftWrites = task;
    return task;
  }
  private fail(error: unknown) {
    this.publish({
      status: this.conflict ? "conflict" : "error",
      message: this.conflict
        ? "The saved prompt changed elsewhere. Your edits are kept here."
        : error instanceof Error
          ? error.message
          : "Could not save the prompt. Retry.",
    });
  }
  async load() {
    try {
      const [remote, draft] = await Promise.all([
        workspace(),
        window.scope.loadPromptDraft(this.tabId),
      ]);
      if (this.disposed || this.loaded) return;
      this.loaded = true;
      this.document = draft ? copy(draft.document) : remote.document;
      this.revision = draft ? draft.revision : remote.revision;
      this.dirty = !!draft;
      this.pending = draft?.pending as PromptWrite | undefined;
      this.conflict = !!draft && !this.pending && remote.revision !== draft.revision;
      this.publish({
        document: this.document,
        status: this.conflict ? "conflict" : draft ? "editing" : "saved",
        message: draft ? "Recovered your local edits." : "",
      });
      if (this.conflict) this.fail(new Error());
      else if (draft) await this.flush();
      await this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }
  edit(document: PromptDocument) {
    this.document = document;
    this.editVersion++;
    this.dirty = true;
    this.publish({ document, status: this.conflict ? "conflict" : "editing" });
    clearTimeout(this.timer);
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      void this.persist().catch((error) => this.fail(error));
    }, 100);
    if (!this.conflict)
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, 300);
  }
  editField(field: PromptField, text: string) {
    this.edit({
      ...this.document,
      parts: { ...this.document.parts, [field]: { ...this.document.parts[field], text } },
    });
  }
  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    clearTimeout(this.draftTimer);
    if (this.inFlight) return this.inFlight.then(() => (this.dirty ? this.flush() : undefined));
    const task = this.saveAll();
    this.inFlight = task;
    void task
      .finally(() => {
        if (this.inFlight === task) this.inFlight = undefined;
      })
      .catch(() => {});
    return task;
  };
  private async saveAll() {
    if (!this.loaded) {
      if (this.snapshot.status === "error")
        throw new Error("Load the current prompt before leaving.");
      return;
    }
    try {
      if (this.conflict) {
        await this.persist();
        throw new Error("Resolve the prompt conflict before leaving.");
      }
      while (this.dirty || this.pending) {
        this.pending ??= {
          action: "update-workspace",
          requestId: crypto.randomUUID(),
          expectedRevision: this.revision,
          document: copy(this.document),
        };
        await this.persist();
        this.publish({ status: "saving", message: "" });
        const sent = this.pending;
        const reply = await promptCommand(sent);
        if (reply.type !== "receipt") throw new Error("Could not confirm the prompt save. Retry.");
        this.revision = reply.workspaceRevision;
        this.pending = undefined;
        this.dirty = !same(this.document, sent.document);
        await this.persist();
      }
      this.publish({ status: "saved", message: "" });
    } catch (error) {
      if (error instanceof PromptFailure && [400, 404, 409].includes(error.status)) {
        this.pending = undefined;
        this.conflict = true;
      }
      await this.persist().catch(() => {});
      this.fail(error);
      throw error;
    }
  }
  async refresh() {
    if (!this.loaded) return;
    const read = ++this.readVersion;
    try {
      await this.inFlight?.catch(() => {});
      const generation = this.editVersion;
      const remote = await workspace();
      if (this.disposed || read !== this.readVersion || remote.revision < this.revision) return;
      if (this.inFlight) {
        void this.refresh();
        return;
      }
      if (this.dirty || generation !== this.editVersion) {
        if (remote.revision !== this.revision) {
          this.conflict = true;
          await this.persist();
          this.fail(new Error());
        }
        return;
      }
      this.revision = remote.revision;
      this.document = remote.document;
      this.publish({ document: this.document, status: "saved", message: "" });
    } catch (error) {
      this.fail(error);
    }
  }
  invalidateLibrary() {
    this.publish({ libraryEpoch: this.snapshot.libraryEpoch + 1 });
  }
  async keepEdits() {
    this.readVersion++;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => {});
    try {
      const remote = await workspace();
      const generation = this.editVersion;
      const document = await sanitizePrompt(this.document);
      if (generation !== this.editVersion)
        throw new Error("Text changed during recovery. Keep your edits again.");
      this.revision = remote.revision;
      this.pending = undefined;
      this.conflict = false;
      this.edit(document);
      await this.flush();
      await this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }
  async useSaved() {
    this.readVersion++;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => {});
    const generation = this.editVersion;
    try {
      const remote = await workspace();
      if (generation !== this.editVersion)
        throw new Error("Text changed during recovery. Use the saved prompt again.");
      this.document = remote.document;
      this.revision = remote.revision;
      this.pending = undefined;
      this.conflict = false;
      this.dirty = false;
      await this.persist();
      this.publish({ document: this.document, status: "saved", message: "" });
    } catch (error) {
      this.fail(error);
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.draftTimer);
  }
}
export function usePromptEditor(context: TabContext) {
  const [editor] = useState(() => new PromptEditor(context.tabId));
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => {
    const stopEvents = window.scope.onPromptsChanged((event) => {
      if (event.libraryChanged) editor.invalidateLibrary();
      if (event.workspaceChanged) void editor.refresh();
    });
    const stopReconnect = window.scope.onPromptsReconnected(() => {
      editor.invalidateLibrary();
      void editor.refresh();
    });
    const stopClose = context.onBeforeClose(editor.flush);
    void editor.load();
    return () => {
      stopEvents();
      stopReconnect();
      stopClose();
      editor.dispose();
    };
  }, [editor]);
  return { ...snapshot, editor };
}
