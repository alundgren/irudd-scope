import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ITEMS,
  type ChatHarnessId,
  type ChatItem,
  type ChatState,
  type ChatTarget,
} from "./contract.ts";
import type { CardToolService } from "./card-tools.ts";
import type { ChatHarness, HarnessEvent, HarnessSession, HarnessTools } from "./harness.ts";

/** Where card chats are kept between restarts. */
export type SavedChats = {
  read: (target: ChatTarget) => Promise<SavedChat | null>;
  save: (target: ChatTarget, chat: SavedChat) => Promise<void>;
  /** Records a working folder Scope made, so it can be removed once its card is gone. */
  folderMade: (cardId: string) => Promise<void>;
  /** Cards with a working folder that are gone for good. */
  goneFolders: () => Promise<string[]>;
  forgetFolder: (cardId: string) => Promise<void>;
};
export type SavedChat = {
  harness: ChatHarnessId | null;
  session: string | null;
  running: boolean;
  items: ChatItem[];
  /** The running turn, so Undo turn still works after Scope quits during it. */
  turn: { id: string; changes: string[] } | null;
};

type Chat = {
  target: ChatTarget;
  harness: ChatHarnessId | null;
  session?: Promise<HarnessSession>;
  sessionId?: string;
  account?: string;
  blocked?: string;
  running: boolean;
  items: ChatItem[];
  /** The running turn, which groups the card changes the agent makes in it. */
  turn?: string;
  changes: string[];
  /** The card version the agent last read, which its edits are checked against. */
  lastRead?: number;
  /** The harness has not finished a turn since starting with `resume`. */
  resuming: boolean;
  /** Counts sessions, so events from a session this chat replaced are ignored. */
  generation: number;
  /** Pending approval items and the session and request they answer. */
  approvals: Map<string, { generation: number; id: string }>;
  saveTimer?: ReturnType<typeof setTimeout>;
};

/**
 * The folder a card's chat runs in. Scope never shows it or reads what is inside. The name
 * includes the profile, so two Scope profiles with a copy of the same board never share one.
 */
export function chatFolder(cardId: string, profile: string): string {
  const tag = createHash("sha256").update(profile).digest("hex").slice(0, 8);
  return join(tmpdir(), "scope-card-chats", `${cardId}-${tag}`);
}
const CARD_ID = /^[a-z0-9]{8}$/;
/** How long streamed text and tool lines wait before the chat is saved. */
const SAVE_DELAY = 500;

const keyOf = (target: ChatTarget) => `${target.tabId}/${target.cardId}`;

/** Each open card's chat: what the panel shows and the harness session behind it. */
export class CardChats {
  private readonly chats = new Map<string, Chat>();
  /** Programs found the last time a card's chat was shown. */
  private found: ChatHarness[] = [];
  constructor(
    private readonly harnesses: ChatHarness[],
    private readonly changed: (target: ChatTarget) => void,
    private readonly saved: SavedChats,
    /** Scope's own data folder, which keeps each profile's chat folders apart. */
    private readonly profile: string,
    private readonly tools?: CardToolService,
  ) {}

  /** Brings a card's chat back from the database before the panel shows it. */
  async load(target: ChatTarget): Promise<void> {
    const present = await Promise.all(
      this.harnesses.map((harness) => harness.available().catch(() => false)),
    );
    this.found = this.harnesses.filter((_harness, index) => present[index]);
    const key = keyOf(target);
    const open = this.chats.get(key);
    if (open) {
      // Reopening the card checks the login again on the next message.
      if (open.blocked && !open.session) delete open.blocked;
      return;
    }
    const row = await this.saved.read(target).catch(() => null);
    if (this.chats.has(key)) return;
    const chat = this.chat(target);
    if (!row) return;
    chat.harness = row.harness;
    chat.sessionId = row.session ?? undefined;
    chat.items = row.items;
    if (row.running) {
      // Scope quit during this turn. It does not continue by itself.
      for (const item of chat.items)
        if (item.kind === "approval" && item.state === "pending")
          Object.assign(item, { state: "denied" });
      this.push(chat, {
        kind: "turn",
        id: row.turn?.id ?? this.nextId("turn"),
        state: "interrupted",
        changes: row.turn?.changes ?? [],
      });
      this.save(chat);
    }
  }

  private save(chat: Chat) {
    clearTimeout(chat.saveTimer);
    chat.saveTimer = undefined;
    void this.saved
      .save(chat.target, {
        harness: chat.harness,
        session: chat.sessionId ?? null,
        running: chat.running,
        items: chat.items,
        turn: chat.turn ? { id: chat.turn, changes: chat.changes } : null,
      })
      .catch(() => console.error("Scope could not save a card chat."));
  }

  /** Saves soon, so a stream of small events is one write. */
  private saveSoon(chat: Chat) {
    chat.saveTimer ??= setTimeout(() => this.save(chat), SAVE_DELAY);
  }

  /** Ends the chat's session; anything it still sends is ignored. */
  private retire(chat: Chat) {
    void chat.session?.then((session) => session.close()).catch(() => {});
    chat.session = undefined;
    chat.generation += 1;
    chat.approvals.clear();
  }

  state(target: ChatTarget | null): ChatState {
    const chat = target && this.chats.get(keyOf(target));
    return {
      target,
      harnesses: this.found.map(({ id, label }) => ({ id, label })),
      harness: chat?.harness ?? this.found[0]?.id ?? null,
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
      chat = {
        target,
        harness: null,
        running: false,
        items: [],
        changes: [],
        resuming: false,
        generation: 0,
        approvals: new Map(),
      };
      this.chats.set(key, chat);
    }
    return chat;
  }

  /** Adds an item, dropping the oldest ones past the limit but never one still waiting for an answer. */
  private push(chat: Chat, item: ChatItem) {
    chat.items.push(item);
    while (chat.items.length > MAX_ITEMS) {
      const oldest = chat.items.findIndex(
        (entry) => !(entry.kind === "approval" && entry.state === "pending"),
      );
      if (oldest < 0) break;
      chat.items.splice(oldest, 1);
    }
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

  private nextId(prefix: string) {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  }

  async send(target: ChatTarget, text: string, harnessId: ChatHarnessId): Promise<void> {
    const chat = this.chat(target);
    if (chat.blocked) throw new Error(chat.blocked);
    if (chat.running) throw new Error("Wait for the current turn to finish, or stop it.");
    const harness = this.found.find((item) => item.id === harnessId);
    if (!harness) throw new Error("That chat program is not available.");
    if (chat.harness && chat.harness !== harnessId) {
      // A saved ID belongs to the other program, even when no session is running after a restart.
      this.retire(chat);
      chat.sessionId = undefined;
    }
    chat.harness = harnessId;
    this.push(chat, { kind: "message", id: this.nextId("person"), role: "person", text });
    chat.running = true;
    chat.turn = this.nextId("turn");
    chat.changes = [];
    this.changed(target);
    this.save(chat);
    try {
      chat.session ??= this.start(chat, harness);
      const session = await chat.session;
      if (chat.blocked) return;
      await session.send(text);
    } catch (error) {
      this.retire(chat);
      if (chat.resuming) this.forgetConversation(chat);
      this.finish(chat, {
        type: "turn-end",
        state: "failed",
        error: error instanceof Error ? error.message : "The chat program could not start.",
      });
    }
  }

  /** The harness no longer has that conversation, so the next message starts a new one. */
  private forgetConversation(chat: Chat) {
    chat.sessionId = undefined;
    chat.resuming = false;
    this.push(chat, {
      kind: "notice",
      id: this.nextId("notice"),
      text: "The earlier conversation couldn't be continued. Your next message starts a new one.",
    });
  }

  private async start(chat: Chat, harness: ChatHarness): Promise<HarnessSession> {
    chat.generation += 1;
    const generation = chat.generation;
    const folder = chatFolder(chat.target.cardId, this.profile);
    // The folder may have been removed since the last turn; the harness keeps its own history.
    await this.saved.folderMade(chat.target.cardId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    chat.resuming = Boolean(chat.sessionId);
    const tools = await this.cardTools(chat);
    return harness.start({
      target: chat.target,
      ...(tools ? { tools } : {}),
      folder,
      ...(chat.sessionId ? { resume: chat.sessionId } : {}),
      onEvent: (event) => {
        if (chat.generation === generation) this.receive(chat, event, generation);
      },
    });
  }

  /** The open card's tools for this chat's agent. */
  private async cardTools(chat: Chat): Promise<HarnessTools | undefined> {
    const service = this.tools;
    const guides = await service?.guides(chat.target);
    if (!service || !guides) return undefined;
    return {
      readGuide: guides.read,
      editGuide: guides.edit,
      read: async () => {
        const { answer, version } = await service.read(chat.target);
        if (version !== undefined) chat.lastRead = version;
        return answer;
      },
      edit: async (input) => {
        const turn = chat.turn;
        if (!chat.running || !turn || this.closed)
          return { ok: false, text: "Card changes are only accepted during a turn." };
        const { answer, changes } = await service.edit(chat.target, turn, input, chat.lastRead);
        if (changes.length && chat.turn === turn) {
          chat.changes.push(...changes);
          this.changed(chat.target);
        }
        return answer;
      },
    };
  }

  private receive(chat: Chat, event: HarnessEvent, generation: number) {
    // Quitting closes every session; a turn cut off then stays running in the database, so it
    // shows as interrupted after the restart.
    if (this.closed) return;
    switch (event.type) {
      case "account":
        chat.account = event.label;
        break;
      case "blocked":
        chat.blocked = event.reason;
        chat.running = false;
        this.retire(chat);
        this.save(chat);
        break;
      case "session":
        chat.sessionId = event.id;
        this.save(chat);
        break;
      case "text": {
        const last = chat.items.at(-1);
        if (last?.kind === "message" && last.role === "agent")
          chat.items[chat.items.length - 1] = { ...last, text: last.text + event.text };
        else if (event.text.trim())
          // A reply after a tool line starts a new message; the break before it is not needed.
          this.push(chat, {
            kind: "message",
            id: this.nextId("agent"),
            role: "agent",
            text: event.text.replace(/^\s+/, ""),
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
      case "approval": {
        // A new session can reuse a request ID, so the item's ID includes the session.
        const id = `approval-${generation}-${event.id}`;
        chat.approvals.set(id, { generation, id: event.id });
        this.push(chat, {
          kind: "approval",
          id,
          title: event.title,
          detail: event.detail,
          state: "pending",
        });
        break;
      }
      case "notice":
        this.push(chat, { kind: "notice", id: this.nextId("notice"), text: event.text });
        break;
      case "turn-end":
        this.finish(chat, event);
        return;
      case "exit":
        chat.session = undefined;
        chat.approvals.clear();
        if (chat.resuming && event.error) this.forgetConversation(chat);
        if (chat.running)
          this.finish(chat, {
            type: "turn-end",
            state: "failed",
            error: event.error ?? "The chat program stopped.",
          });
        return;
    }
    this.changed(chat.target);
    this.saveSoon(chat);
  }

  private finish(chat: Chat, event: Extract<HarnessEvent, { type: "turn-end" }>) {
    const id = chat.turn ?? this.nextId("turn");
    const changes = chat.changes;
    chat.turn = undefined;
    chat.changes = [];
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
    chat.resuming = false;
    this.changed(chat.target);
    this.save(chat);
  }

  async approve(target: ChatTarget, id: string, allow: boolean): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    const item = chat?.items.find((entry) => entry.id === id);
    const request = chat?.approvals.get(id);
    if (
      !chat?.session ||
      item?.kind !== "approval" ||
      item.state !== "pending" ||
      request?.generation !== chat.generation
    )
      throw new Error("That request is no longer waiting for an answer.");
    chat.approvals.delete(id);
    this.update(chat, item.id, "approval", (entry) => ({
      ...entry,
      state: allow ? "allowed" : "denied",
    }));
    this.changed(target);
    this.save(chat);
    (await chat.session).approve(request.id, allow);
  }

  /**
   * The card's editor closed. Its chat program stops with it, the way quitting stops it; the
   * next message continues the conversation.
   */
  leave(target: ChatTarget) {
    const chat = this.chats.get(keyOf(target));
    if (!chat?.session) return;
    const running = chat.running;
    this.retire(chat);
    if (running) this.finish(chat, { type: "turn-end", state: "stopped" });
  }

  async stop(target: ChatTarget): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    if (!chat?.running || !chat.session) return;
    (await chat.session).stop();
  }

  async undoTurn(target: ChatTarget, turnId: string): Promise<void> {
    const chat = this.chats.get(keyOf(target));
    const item = chat?.items.find((entry) => entry.id === turnId);
    if (!chat || item?.kind !== "turn" || !item.changes.length || item.undone || !this.tools)
      throw new Error("That turn has nothing to undo.");
    const notices = await this.tools.undoTurn(target, turnId);
    this.update(chat, turnId, "turn", (entry) => ({ ...entry, undone: true }));
    for (const text of notices)
      this.push(chat, { kind: "notice", id: this.nextId("notice"), text });
    this.changed(target);
    this.save(chat);
  }

  /**
   * Removes the working folders of cards that are gone for good: not on any board and no
   * longer in any history that could bring them back. Only folders this Scope made are touched.
   */
  async sweep(): Promise<void> {
    try {
      const running = new Set(
        [...this.chats.values()].filter((chat) => chat.session).map((chat) => chat.target.cardId),
      );
      for (const cardId of await this.saved.goneFolders()) {
        if (!CARD_ID.test(cardId) || running.has(cardId)) continue;
        await rm(chatFolder(cardId, this.profile), { recursive: true, force: true });
        await this.saved.forgetFolder(cardId);
      }
    } catch {
      console.error("Scope could not remove a card chat folder.");
    }
  }

  /** Ends the chats of tabs that were removed, then removes folders nothing can use again. */
  removed(tabIds: readonly string[]) {
    for (const [key, chat] of this.chats)
      if (tabIds.includes(chat.target.tabId)) {
        clearTimeout(chat.saveTimer);
        this.retire(chat);
        this.chats.delete(key);
      }
    void this.sweep();
  }

  private closed = false;
  close() {
    this.closed = true;
    for (const chat of this.chats.values()) {
      if (chat.saveTimer) this.save(chat);
      void chat.session?.then((session) => session.close()).catch(() => {});
    }
    this.chats.clear();
  }
}
