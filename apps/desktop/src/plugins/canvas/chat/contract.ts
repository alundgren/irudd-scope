import { Schema } from "effect";
import { Uuid } from "../../../workspace/contract.ts";
import { CanvasId } from "../contract.ts";

export const MAX_MESSAGE = 20_000;
/** The panel keeps the newest items; older ones stay in the harness's own history. */
export const MAX_ITEMS = 500;

export const ChatHarnessId = Schema.Literals(["claude", "codex"]);
export type ChatHarnessId = typeof ChatHarnessId.Type;

const ChoiceName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * The program, model, reasoning level and speed every card chat uses, chosen in Settings.
 * Names are kept beside IDs so the chat header can show them without asking the program.
 * A missing model, effort or speed leaves that to the program's own default.
 */
export const ChatProgramChoice = Schema.Struct({
  harness: ChatHarnessId,
  model: Schema.optionalKey(ChoiceName),
  modelName: Schema.optionalKey(ChoiceName),
  effort: Schema.optionalKey(ChoiceName),
  /** `standard`, or a faster option the model offers, such as Claude's `fast`. */
  speed: Schema.optionalKey(ChoiceName),
  speedName: Schema.optionalKey(ChoiceName),
});
export type ChatProgramChoice = typeof ChatProgramChoice.Type;

/** The speed every model offers: the program's normal service. */
export const STANDARD_SPEED = "standard";

export type ChatOption = { id: string; label: string };
/** A reasoning level's name in menus, such as "Extra high" for `xhigh`. */
export const effortLabel = (effort: string) =>
  effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
/** A model an installed program offers, with the reasoning levels and speeds it supports. */
export type ChatModel = {
  id: string;
  label: string;
  efforts: ChatOption[];
  defaultEffort?: string;
  /** Always starts with the standard speed. */
  speeds: ChatOption[];
  defaultSpeed?: string;
  isDefault?: boolean;
};
/** What Settings shows for one program. `problem` says why it offers no models. */
export type ChatProgramModels = {
  id: ChatHarnessId;
  label: string;
  installed: boolean;
  models: ChatModel[];
  problem?: string;
};

/**
 * `refresh` asks the programs again even when Scope already has their lists, at most once a
 * minute per program. Settings sends it when its section opens and on Retry.
 */
export const ChatProgramsRequest = Schema.UndefinedOr(
  Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) }),
);
export type ChatProgramsRequest = typeof ChatProgramsRequest.Type;

/** The model a program uses when nothing valid is chosen. */
export const defaultModel = (models: readonly ChatModel[]) =>
  models.find((model) => model.isDefault) ?? models[0];

/**
 * The choice that applies with the models a program offers now. Settings shows it, the chat
 * header names it and each message sends it. A saved model the program no longer offers becomes
 * its default model, and a reasoning level or speed the model no longer offers becomes the
 * model's default. Anything not chosen stays the program's own default. A choice for another
 * program, or one that can't be checked because the models aren't known, is used as saved.
 */
export function resolveChoice(
  harness: ChatHarnessId,
  models: readonly ChatModel[],
  saved: ChatProgramChoice | null,
): ChatProgramChoice {
  const own = saved?.harness === harness ? saved : undefined;
  if (!own?.model || !models.length) return own ?? { harness };
  const model = models.find((entry) => entry.id === own.model) ?? defaultModel(models)!;
  const effort =
    own.effort === undefined
      ? undefined
      : model.efforts.some((entry) => entry.id === own.effort)
        ? own.effort
        : model.efforts.find((entry) => entry.id === model.defaultEffort)?.id;
  const speed =
    own.speed === undefined
      ? undefined
      : (model.speeds.find((entry) => entry.id === own.speed) ??
        model.speeds.find((entry) => entry.id === model.defaultSpeed) ??
        model.speeds[0]);
  return {
    harness,
    model: model.id,
    modelName: model.label,
    ...(effort ? { effort } : {}),
    ...(speed ? { speed: speed.id, speedName: speed.label } : {}),
  };
}

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

/** Everything the panel shows for one card's chat. Main sends it whole after each change. */
export type ChatState = {
  target: ChatTarget | null;
  /** The program the next message goes to, from Settings; null when none is installed. */
  harness: ChatHarnessId | null;
  /** What runs, such as "Codex · GPT-6.1 Terra · high · fast". */
  runs?: string;
  /** Names the account the chat uses, such as "Max plan", once the harness says. */
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
