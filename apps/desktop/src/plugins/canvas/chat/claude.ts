import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  query,
  tool,
  type AccountInfo,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  ChatHarness,
  HarnessEvent,
  HarnessStart,
  HarnessTools,
  ToolAnswer,
} from "./harness.ts";

export const BILLED_TO_KEY = "This would be billed to your API key, so chat is off.";

/** Chat runs only on a Claude plan login, never on an API key or another provider. */
export function planName(account: AccountInfo): string | null {
  if (account.apiProvider !== "firstParty" || account.apiKeySource || !account.subscriptionType)
    return null;
  return account.subscriptionType;
}

/** Messages the person sends, handed to the SDK one at a time as they arrive. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;

  push(text: string) {
    this.waiting.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.waiting.shift();
      if (next) yield next;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/** Scope's card tools, as Claude names them. They act only on the open card, so they never ask. */
const CARD_TOOL = /^mcp__scope__(read_diagram|edit_diagram)$/;

const CARD_TOOL_NAMES: Record<string, string> = {
  mcp__scope__read_diagram: "Read card",
  mcp__scope__edit_diagram: "Change card",
};

const reply = (answer: ToolAnswer) => ({
  content: [{ type: "text" as const, text: answer.text }],
  ...(answer.ok ? {} : { isError: true }),
});

// Claude defers MCP tools until it searches for them; the card tools are the point of the chat.
const LOADED = { alwaysLoad: true };

function cardServer(tools: HarnessTools | undefined) {
  return createSdkMcpServer({
    name: "scope",
    version: "1.0.0",
    tools: tools
      ? [
          tool("read_diagram", tools.readGuide, {}, async () => reply(await tools.read()), LOADED),
          tool(
            "edit_diagram",
            tools.editGuide,
            {
              changes: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
              version: z.number().int().min(0).optional(),
              requestId: z.string().max(56).optional(),
            },
            async (input) => reply(await tools.edit(input)),
            LOADED,
          ),
        ]
      : [],
  });
}

/** A short line for the panel naming what a tool call does, such as the command it runs. */
function toolDetail(input: Record<string, unknown>): string | undefined {
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"])
    if (typeof input[key] === "string") return (input[key] as string).slice(0, 300);
  return undefined;
}

function approvalTitle(name: string): string {
  if (name === "Bash") return "Run a command?";
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "Change a file?";
  return `Use ${name}?`;
}

function approvalDetail(input: Record<string, unknown>): string {
  return (toolDetail(input) ?? JSON.stringify(input, null, 2)).slice(0, 4000);
}

/** Stops a program Scope started and everything it started, the way gh calls are stopped. */
function stopGroup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The program can exit between the check and the kill.
  }
}

/**
 * Card chat through the person's own `claude` program and the Claude Agent SDK. The SDK's
 * defaults stay, so the session loads the person's settings, tools and MCP servers; Scope only
 * adds its card server and answers approvals in the panel.
 */
export function claudeHarness({
  program,
  path,
}: {
  /** Finds the person's claude program, or null when it is not installed. */
  program: () => Promise<string | null>;
  /** PATH for the program, including folders a GUI launch leaves out. */
  path: string;
}): ChatHarness {
  return {
    id: "claude",
    label: "Claude",
    available: async () => (await program()) !== null,
    async start({ folder, resume, tools, onEvent }: HarnessStart) {
      const binary = await program();
      if (!binary) throw new Error("Scope can't find the claude program.");
      const inbox = new Inbox();
      const children = new Set<ChildProcess>();
      const approvals = new Map<string, (allow: boolean) => void>();
      let stopping = false;
      let lastText = false;
      const emit = (event: HarnessEvent) => onEvent(event);

      const run = query({
        prompt: inbox,
        options: {
          pathToClaudeCodeExecutable: binary,
          cwd: folder,
          ...(resume ? { resume } : {}),
          env: { ...process.env, PATH: path },
          mcpServers: { scope: cardServer(tools) },
          canUseTool: (name, input, { signal }) =>
            new Promise((resolve) => {
              if (CARD_TOOL.test(name)) {
                resolve({ behavior: "allow", updatedInput: input });
                return;
              }
              const id = randomUUID();
              const answer = (allow: boolean) => {
                approvals.delete(id);
                resolve(
                  allow
                    ? { behavior: "allow", updatedInput: input }
                    : { behavior: "deny", message: "The person denied this in Scope." },
                );
              };
              approvals.set(id, answer);
              signal.addEventListener("abort", () => answer(false), { once: true });
              emit({
                type: "approval",
                id,
                title: approvalTitle(name),
                detail: approvalDetail(input),
              });
            }),
          // Its own process group, so closing the chat or quitting Scope stops what it started.
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              detached: process.platform !== "win32",
              windowsHide: true,
              stdio: ["pipe", "pipe", "ignore"],
            });
            children.add(child);
            child.once("exit", () => children.delete(child));
            options.signal?.addEventListener("abort", () => stopGroup(child), { once: true });
            return child;
          },
        },
      });

      const close = () => {
        inbox.end();
        for (const answer of approvals.values()) answer(false);
        run.close();
        for (const child of children) stopGroup(child);
      };

      // The account check happens before any message is sent, so it costs nothing.
      let account: AccountInfo;
      try {
        account = await run.accountInfo();
      } catch (error) {
        close();
        throw error;
      }
      const plan = planName(account);
      if (!plan) {
        emit({ type: "blocked", reason: BILLED_TO_KEY });
        close();
        return { send: async () => {}, approve: () => {}, stop: () => {}, close: () => {} };
      }
      // The header already names Claude; the plan reads like "Claude Max".
      emit({ type: "account", label: `${plan.replace(/^Claude\s+/i, "")} plan` });

      const receive = (message: SDKMessage) => {
        if (message.type === "system" && message.subtype === "init")
          emit({ type: "session", id: message.session_id });
        else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) {
              emit({ type: "text", text: lastText ? `\n\n${block.text}` : block.text });
              lastText = true;
            } else if (block.type === "tool_use") {
              const input = (block.input ?? {}) as Record<string, unknown>;
              const detail = toolDetail(input);
              emit({
                type: "tool-start",
                id: block.id,
                name: CARD_TOOL_NAMES[block.name] ?? block.name,
                ...(detail ? { detail } : {}),
              });
              lastText = false;
            }
          }
        } else if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content)
            if (typeof block === "object" && block.type === "tool_result")
              emit({ type: "tool-end", id: block.tool_use_id, ok: block.is_error !== true });
        } else if (message.type === "result") {
          lastText = false;
          const stopped = stopping;
          stopping = false;
          if (message.subtype === "success" && !message.is_error)
            emit({ type: "turn-end", state: "done" });
          else if (stopped) emit({ type: "turn-end", state: "stopped" });
          else
            emit({
              type: "turn-end",
              state: "failed",
              error:
                "errors" in message && message.errors.length
                  ? message.errors.join(" ").slice(0, 500)
                  : "Claude could not finish the turn.",
            });
        }
      };
      void (async () => {
        try {
          for await (const message of run) receive(message);
          emit({ type: "exit" });
        } catch (error) {
          emit({ type: "exit", error: error instanceof Error ? error.message : undefined });
        } finally {
          close();
        }
      })();

      return {
        send: async (text) => inbox.push(text),
        approve: (id, allow) => approvals.get(id)?.(allow),
        stop: () => {
          stopping = true;
          for (const answer of approvals.values()) answer(false);
          void run.interrupt().catch(() => {});
        },
        close,
      };
    },
  };
}
