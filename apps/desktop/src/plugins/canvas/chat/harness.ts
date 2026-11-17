import type { ChatHarnessId, ChatTarget } from "./contract.ts";

/** What a running harness tells the panel. Text arrives in pieces and is joined per turn. */
export type HarnessEvent =
  | { type: "account"; label: string }
  | { type: "blocked"; reason: string }
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string; detail?: string }
  | { type: "tool-end"; id: string; ok: boolean }
  | { type: "approval"; id: string; title: string; detail: string }
  | { type: "card-change"; turnId: string; summary: string }
  | { type: "turn-end"; turnId?: string; state: "done" | "stopped" | "failed"; error?: string }
  | { type: "notice"; text: string }
  | { type: "exit"; error?: string };

export type HarnessStart = {
  target: ChatTarget;
  /** The card's own working folder in the OS temp folder. */
  folder: string;
  /** The harness session to continue, saved from an earlier `session` event. */
  resume?: string;
  onEvent: (event: HarnessEvent) => void;
};

/** One running conversation with the person's own claude or codex program. */
export type HarnessSession = {
  send: (text: string) => Promise<void>;
  approve: (id: string, allow: boolean) => void;
  stop: () => void;
  close: () => void;
};

/** A program Scope can chat through. claude-chat and codex-chat each add one. */
export type ChatHarness = {
  id: ChatHarnessId;
  label: string;
  start: (options: HarnessStart) => Promise<HarnessSession>;
};
