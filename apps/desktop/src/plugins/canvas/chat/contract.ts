import { Schema } from "effect";
import { Uuid } from "../../../workspace/contract.ts";
import { CanvasId } from "../contract.ts";

export const MAX_MESSAGE = 20_000;
/** The panel keeps the newest items; older ones stay in the harness's own history. */
export const MAX_ITEMS = 500;

export const ChatHarnessId = Schema.Literals(["claude", "codex"]);
export type ChatHarnessId = typeof ChatHarnessId.Type;

/** The card a chat belongs to. Each card has at most one chat. */
export const ChatTarget = Schema.Struct({ tabId: Uuid, cardId: CanvasId });
export type ChatTarget = typeof ChatTarget.Type;

/** Where the card editor keeps room for the panel, in the workspace page's CSS pixels. */
export const ChatBounds = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ChatBounds = typeof ChatBounds.Type;
export const ChatTheme = Schema.Literals(["light", "dark"]);
export type ChatTheme = typeof ChatTheme.Type;
export const ChatLayout = Schema.Struct({
  target: ChatTarget,
  bounds: Schema.NullOr(ChatBounds),
  /** The workspace page's colors, which follow Scope's Appearance setting. */
  theme: ChatTheme,
  /** The card's editor closed, which stops its chat program. */
  closed: Schema.optionalKey(Schema.Boolean),
});
export type ChatLayout = typeof ChatLayout.Type;

export const ChatSend = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_MESSAGE)),
  harness: ChatHarnessId,
});
export const ChatApprove = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  allow: Schema.Boolean,
});
export const ChatUndoTurn = Schema.Struct({
  turnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export type ChatItem =
  | { kind: "message"; id: string; role: "person" | "agent"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      detail?: string;
      state: "running" | "done" | "failed";
    }
  | {
      kind: "approval";
      id: string;
      title: string;
      detail: string;
      state: "pending" | "allowed" | "denied";
    }
  | {
      kind: "turn";
      id: string;
      state: "done" | "stopped" | "interrupted" | "failed";
      /** One line per change the turn made to the card, such as "Added Retry queue". */
      changes: string[];
      undone?: boolean;
      error?: string;
    }
  | { kind: "notice"; id: string; text: string };

export type ChatHarnessChoice = { id: ChatHarnessId; label: string };

/** Everything the panel shows for one card's chat. Main sends it whole after each change. */
export type ChatState = {
  target: ChatTarget | null;
  harnesses: ChatHarnessChoice[];
  harness: ChatHarnessId | null;
  /** Names the account the chat uses, such as "Claude · Max plan", once the harness says. */
  account?: string;
  running: boolean;
  /** Why chat can't start, such as an API key login. The composer stays off while set. */
  blocked?: string;
  items: ChatItem[];
};

/** What the chat view's preload exposes as `window.scopeChat`. Nothing else reaches it. */
export type ScopeChatBridge = {
  state: () => Promise<ChatState>;
  send: (input: typeof ChatSend.Type) => Promise<void>;
  approve: (input: typeof ChatApprove.Type) => Promise<void>;
  stop: () => Promise<void>;
  undoTurn: (input: typeof ChatUndoTurn.Type) => Promise<void>;
  onState: (listener: (state: ChatState) => void) => () => void;
  onTheme: (listener: (theme: ChatTheme) => void) => () => void;
};
