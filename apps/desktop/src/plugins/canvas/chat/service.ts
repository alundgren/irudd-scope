import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ITEMS,
  type ChatHarnessId,
  type ChatItem,
  type ChatState,
  type ChatTarget,
} from "./contract.ts";
import type { ChatHarness, HarnessEvent, HarnessSession } from "./harness.ts";

type Chat = {
  target: ChatTarget;
  harness: ChatHarnessId | null;
  session?: Promise<HarnessSession>;
  sessionId?: string;
  account?: string;
  blocked?: string;
  running: boolean;
  items: ChatItem[];
  changes: Map<string, string[]>;
  serial: number;
};

/** The folder a card's chat runs in. Scope never shows it or reads what is inside. */
export function chatFolder(cardId: string): string {
  return join(tmpdir(), "scope-card-chats", cardId);
}

const keyOf = (target: ChatTarget) => `${target.tabId}/${target.cardId}`;

/** Each open card's chat: what the panel shows and the harness session behind it. */
export class CardChats {
  private readonly chats = new Map<string, Chat>();
  /** Undoes one agent turn on its card. card-tools provides it. */
  undo?: (target: ChatTarget, turnId: string) => Promise<void>;

  constructor(
    private readonly harnesses: ChatHarness[],
    private readonly changed: (target: ChatTarget) => void,
  ) {}

  state(target: ChatTarget | null): ChatState {
    const chat = target && this.chats.get(keyOf(target));
    return {
      target,
      harnesses: this.harnesses.map(({ id, label }) => ({ id, label })),
      harness: chat?.harness ?? this.harnesses[0]?.id ?? null,
      running: chat?.running ?? false,
      items: chat?.items ?? [],
      ...(chat?.account ? { account: chat.account } : {}),
      ...(chat?.blocked ? { blocked: chat.blocked } : {}),
    };
  }

  private chat(target: ChatTarget): Chat {
    const key = keyOf(target);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { target, harness: null, running: false, items: [], changes: new Map(), serial: 0 };
      this.chats.set(key, chat);
    }
    return chat;
  }

  private push(chat: Chat, item: ChatItem) {
    chat.items.push(item);
    if (chat.items.length > MAX_ITEMS) chat.items.splice(0, chat.items.length - MAX_ITEMS);
  }

  private update<K extends ChatItem["kind"]>(
    chat: Chat,
    id: string,
    kind: K,
    change: (item: Extract<ChatItem, { kind: K }>) => Extract<ChatItem, { kind: K }>,
  ) {
    const index = chat.items.findIndex((item) => item.id === id && item.kind === kind);
    if (index >= 0) chat.items[index] = change(chat.items[index] as Extract<ChatItem, { kind: K }>);
  }

  private nextId(chat: Chat, prefix: string) {
    return `${prefix}-${++chat.serial}`;
  }

  async send(target: ChatTarget, text: string, harnessId: ChatHarnessId): Promise<void> {
    const chat = this.chat(target);
    if (chat.blocked) throw new Error(chat.blocked);
    if (chat.running) throw new Error("Wait for the current turn to finish, or stop it.");
    const harness = this.harnesses.find((item) => item.id === harnessId);
    if (!harness) throw new Error("That chat program is not available.");
    if (chat.harness && chat.harness !== harnessId && chat.session) {
      void chat.session.then((session) => session.close()).catch(() => {});
      chat.session = undefined;
      chat.sessionId = undefined;
    }
    chat.harness = harnessId;
    this.push(chat, { kind: "message", id: this.nextId(chat, "person"), role: "person", text });
    chat.running = true;
    this.changed(target);
    try {
      chat.session ??= this.start(chat, harness);
      const session = await chat.session;
      if (chat.blocked) return;
      await session.send(text);
    } catch (error) {
      chat.session = undefined;
      this.finish(chat, {
        type: "turn-end",
        state: "failed",
        error: error instanceof Error ? error.message : "The chat program could not start.",
      });
    }
  }

  private async start(chat: Chat, harness: ChatHarness): Promise<HarnessSession> {
    const folder = chatFolder(chat.target.cardId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return harness.start({
      target: chat.target,
      folder,
      ...(chat.sessionId ? { resume: chat.sessionId } : {}),
      onEvent: (event) => this.receive(chat, event),
    });
  }

  private receive(chat: Chat, event: HarnessEvent) {
    switch (event.type) {
      case "account":
        chat.account = event.label;
        break;
      case "blocked":
        chat.blocked = event.reason;
        chat.running = false;
        void chat.session?.then((session) => session.close()).catch(() => {});
        chat.session = undefined;
        break;
      case "session":
        chat.sessionId = event.id;
        break;
      case "text": {
        const last = chat.items.at(-1);
        if (last?.kind === "message" && last.role === "agent")
          chat.items[chat.items.length - 1] = { ...last, text: last.text + event.text };
        else
          this.push(chat, {
            kind: "message",
            id: this.nextId(chat, "agent"),
            role: "agent",
            text: event.text,
          });
        break;
      }
      case "tool-start":
        this.push(chat, {
          kind: "tool",
          id: `tool-${event.id}`,
          name: event.name,
          state: "running",
          ...(event.detail ? { detail: event.detail } : {}),
        });
        break;
      case "tool-end":
        this.update(chat, `tool-${event.id}`, "tool", (item) => ({
          ...item,
          state: event.ok ? "done" : "failed",
        }));
        break;
      case "approval":
        this.push(chat, {
          kind: "approval",
          id: `approval-${event.id}`,
          title: event.title,
          detail: event.detail,
          state: "pending",
        });
        break;
      case "card-change": {
        const list = chat.changes.get(event.turnId) ?? [];
        list.push(event.summary);
        chat.changes.set(event.turnId, list);
        break;
      }
      case "notice":
        this.push(chat, { kind: "notice", id: this.nextId(chat, "notice"), text: event.text });
        break;
      case "turn-end":
        this.finish(chat, event);
        return;
      case "exit":
        chat.session = undefined;
        if (chat.running)
          this.finish(chat, {
            type: "turn-end",
            state: "failed",
            error: event.error ?? "The chat program stopped.",
          });
        return;
    }
    this.changed(chat.target);
  }

  private finish(chat: Chat, event: Extract<HarnessEvent, { type: "turn-end" }>) {
    const id = event.turnId ?? this.nextId(chat, "turn");
    const changes = chat.changes.get(id) ?? [];
    chat.changes.delete(id);
    for (const item of chat.items)
      if (item.kind === "approval" && item.state === "pending")
        Object.assign(item, { state: "denied" });
    this.push(chat, {
      kind: "turn",
      id,
      state: event.state,
      changes,
      ...(event.error ? { error: event.error } : {}),
    });
    chat.running = false;
    this.changed(chat.target);
  }

  async approve(target: ChatTarget, id: string, allow: boolean): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    const item = chat?.items.find((entry) => entry.id === `approval-${id}`);
    if (!chat?.session || item?.kind !== "approval" || item.state !== "pending")
      throw new Error("That request is no longer waiting for an answer.");
    this.update(chat, item.id, "approval", (entry) => ({
      ...entry,
      state: allow ? "allowed" : "denied",
    }));
    this.changed(target);
    (await chat.session).approve(id, allow);
  }

  async stop(target: ChatTarget): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    if (!chat?.running || !chat.session) return;
    (await chat.session).stop();
  }

  async undoTurn(target: ChatTarget, turnId: string): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    const item = chat?.items.find((entry) => entry.id === turnId);
    if (!chat || item?.kind !== "turn" || !item.changes.length || item.undone || !this.undo)
      throw new Error("That turn has nothing to undo.");
    await this.undo(target, turnId);
    this.update(chat, turnId, "turn", (entry) => ({ ...entry, undone: true }));
    this.changed(target);
  }

  close() {
    for (const chat of this.chats.values())
      void chat.session?.then((session) => session.close()).catch(() => {});
    this.chats.clear();
  }
}
