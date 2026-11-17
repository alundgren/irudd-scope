import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  BILLED_TO_KEY,
  type ChatHarness,
  type HarnessEvent,
  type HarnessStart,
  type HarnessTools,
  type ToolAnswer,
} from "./harness.ts";
import { startProgram, stopGroup } from "./process.ts";

/** Dynamic tools and their requests are experimental in Codex; older versions lack them. */
export const MIN_CODEX = [0, 169, 0] as const;
const TOO_OLD = `Card chat needs Codex ${MIN_CODEX.join(".")} or newer.`;
const RESUME_FAILED =
  "The earlier conversation couldn't be continued. This message starts a new one.";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};
type Item = { type: string; id: string; [key: string]: unknown };

/** The version in the app-server's user agent, such as "scope/0.169.0 (Ubuntu ...)". */
export function codexVersion(userAgent: unknown): number[] | null {
  const match = typeof userAgent === "string" ? /\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent) : null;
  return match ? match.slice(1).map(Number) : null;
}

const atLeast = (version: readonly number[], minimum: readonly number[]) => {
  for (let index = 0; index < minimum.length; index++)
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  return true;
};

const PLAN_NAMES: Record<string, string> = { prolite: "Pro Lite", promax: "Pro Max" };
const planLabel = (plan: string) =>
  PLAN_NAMES[plan] ?? plan.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

/** Codex's tool list entries for Scope's card tools. */
function dynamicTools(tools: HarnessTools) {
  return [
    {
      type: "function",
      name: "read_diagram",
      description: tools.readGuide,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "edit_diagram",
      description: tools.editGuide,
      inputSchema: {
        type: "object",
        properties: {
          changes: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 50 },
          version: { type: "integer", minimum: 0 },
          requestId: { type: "string", maxLength: 56 },
        },
        required: ["changes"],
        additionalProperties: false,
      },
    },
  ];
}

const TOOL_NAMES: Record<string, string> = {
  read_diagram: "Read card",
  edit_diagram: "Change card",
};

const textOf = (value: unknown) => (typeof value === "string" ? value : "");

/** What the panel shows for an item Codex starts, or nothing for items it does not list. */
function itemLine(item: Item): { name: string; detail?: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { name: "Command", detail: textOf(item.command).slice(0, 300) };
    case "fileChange": {
      const paths = (item.changes as { path: string }[] | undefined)?.map((change) => change.path);
      return { name: "Edit files", ...(paths?.length ? { detail: paths.join(", ") } : {}) };
    }
    case "dynamicToolCall":
      return { name: TOOL_NAMES[String(item.tool)] ?? String(item.tool) };
    case "mcpToolCall":
      return { name: `${String(item.server)} ${String(item.tool)}` };
    case "webSearch":
      return { name: "Web search" };
    default:
      return undefined;
  }
}

const FAILED_STATES = new Set(["failed", "declined"]);

/**
 * Card chat through the person's own `codex app-server`. The thread keeps the person's own
 * config, so its approval policy, sandbox, tools and MCP servers apply; Scope only adds its
 * card tools and answers approvals in the panel.
 */
export function codexHarness({
  program,
  path,
}: {
  program: () => Promise<string | null>;
  path: string;
}): ChatHarness {
  return {
    id: "codex",
    label: "Codex",
    available: async () => (await program()) !== null,
    async start({ folder, resume, tools, onEvent }: HarnessStart) {
      const binary = await program();
      if (!binary) throw new Error("Scope can't find the codex program.");
      const child = startProgram(binary, ["app-server"], {
        cwd: folder,
        env: { ...process.env, PATH: path },
      });
      const emit = (event: HarnessEvent) => onEvent(event);
      const waiting = new Map<number, { resolve: (result: Message) => void }>();
      const approvals = new Map<string, (allow: boolean) => void>();
      const lines = new Map<string, string[]>();
      let next = 0;
      let threadId = "";
      let turnId = "";
      /** The last turn that finished, whose late turn/start answer must not bring it back. */
      let finished = "";
      let stopping = false;
      let closed = false;
      let lastMessage = "";
      const streamed = new Set<string>();

      const write = (message: Record<string, unknown>) => {
        if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const request = (method: string, params: Record<string, unknown>) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const id = ++next;
          waiting.set(id, {
            resolve: (message) =>
              message.error
                ? reject(new Error(message.error.message ?? `${method} failed.`))
                : resolve(message.result ?? {}),
          });
          write({ method, id, params });
        });
      const close = () => {
        if (closed) return;
        for (const answer of approvals.values()) answer(false);
        closed = true;
        stopGroup(child);
      };

      const text = (itemId: string, delta: string) => {
        if (!delta) return;
        const joined = lastMessage && lastMessage !== itemId ? `\n\n${delta}` : delta;
        lastMessage = itemId;
        emit({ type: "text", text: joined });
      };

      const ask = (
        id: Message["id"],
        title: string,
        detail: string,
        reply: (allow: boolean) => unknown,
      ) => {
        const key = randomUUID();
        approvals.set(key, (allow) => {
          approvals.delete(key);
          write({ id, result: reply(allow) });
        });
        emit({ type: "approval", id: key, title, detail: detail.slice(0, 4000) });
      };

      const serve = async (message: Message) => {
        const params = message.params ?? {};
        switch (message.method) {
          case "item/tool/call": {
            const name = String(params.tool);
            const input = (params.arguments ?? {}) as Record<string, unknown>;
            const answer: ToolAnswer = !tools
              ? { ok: false, text: "This card has no tools." }
              : name === "read_diagram"
                ? await tools.read()
                : name === "edit_diagram"
                  ? await tools.edit({
                      changes: input.changes,
                      ...(Number.isInteger(input.version)
                        ? { version: input.version as number }
                        : {}),
                      ...(typeof input.requestId === "string"
                        ? { requestId: input.requestId }
                        : {}),
                    })
                  : { ok: false, text: `Scope has no tool named ${name}.` };
            write({
              id: message.id,
              result: {
                contentItems: [
                  { type: "inputText", text: answer.text },
                  ...(answer.png
                    ? [{ type: "inputImage", imageUrl: `data:image/png;base64,${answer.png}` }]
                    : []),
                ],
                success: answer.ok,
              },
            });
            return;
          }
          case "item/commandExecution/requestApproval":
            return ask(
              message.id,
              "Run a command?",
              textOf(params.command) || textOf(params.reason) || "A command",
              (allow) => ({ decision: allow ? "accept" : "decline" }),
            );
          case "item/fileChange/requestApproval":
            return ask(
              message.id,
              "Change a file?",
              (lines.get(String(params.itemId)) ?? []).join("\n") ||
                textOf(params.reason) ||
                textOf(params.grantRoot) ||
                "Files in the card's folder",
              (allow) => ({ decision: allow ? "accept" : "decline" }),
            );
          case "item/permissions/requestApproval":
            return ask(
              message.id,
              "Allow more access?",
              textOf(params.reason) || JSON.stringify(params.permissions ?? {}, null, 2),
              (allow) => ({ permissions: allow ? (params.permissions ?? {}) : {}, scope: "turn" }),
            );
          default:
            // Questions Scope can't put to the person, such as MCP sign-ins, are declined.
            write({
              id: message.id,
              error: { code: -32601, message: "Scope can't answer this request." },
            });
        }
      };

      const notice = (message: Message) => {
        const params = message.params ?? {};
        // Agents Codex starts for this turn have threads of their own; only this chat's counts.
        if (threadId && typeof params.threadId === "string" && params.threadId !== threadId) return;
        const item = params.item as Item | undefined;
        switch (message.method) {
          case "item/agentMessage/delta":
            streamed.add(String(params.itemId));
            return text(String(params.itemId), textOf(params.delta));
          case "item/started": {
            if (!item) return;
            if (item.type === "fileChange")
              lines.set(
                item.id,
                ((item.changes as { path: string }[] | undefined) ?? []).map(
                  (change) => change.path,
                ),
              );
            const line = itemLine(item);
            if (line) emit({ type: "tool-start", id: item.id, ...line });
            return;
          }
          case "item/completed": {
            if (!item) return;
            if (item.type === "agentMessage" && !streamed.has(item.id))
              return text(item.id, textOf(item.text));
            if (itemLine(item))
              emit({
                type: "tool-end",
                id: item.id,
                ok: !FAILED_STATES.has(String(item.status)) && item.success !== false,
              });
            return;
          }
          case "turn/completed": {
            const turn = (params.turn ?? {}) as {
              id?: string;
              status?: string;
              error?: { message?: string };
            };
            if (turnId && turn.id && turn.id !== turnId) return;
            finished = turn.id ?? "";
            const wasStopping = stopping;
            stopping = false;
            turnId = "";
            lastMessage = "";
            if (turn.status === "completed") emit({ type: "turn-end", state: "done" });
            else if (turn.status === "interrupted" || wasStopping)
              emit({ type: "turn-end", state: "stopped" });
            else
              emit({
                type: "turn-end",
                state: "failed",
                error: (turn.error?.message ?? "Codex could not finish the turn.").slice(0, 500),
              });
            return;
          }
        }
      };

      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        let message: Message;
        try {
          message = JSON.parse(line) as Message;
        } catch {
          return;
        }
        if (message.method && message.id !== undefined)
          void serve(message).catch(() =>
            write({ id: message.id, error: { code: -32603, message: "Scope could not answer." } }),
          );
        else if (message.method) notice(message);
        else if (typeof message.id === "number") {
          waiting.get(message.id)?.resolve(message);
          waiting.delete(message.id);
        }
      });
      let ended = false;
      const end = (error?: string) => {
        if (ended) return;
        ended = true;
        const early = !closed;
        close();
        for (const { resolve } of waiting.values())
          resolve({ error: { message: error ?? "Codex stopped." } });
        waiting.clear();
        if (early) emit({ type: "exit", ...(error ? { error } : {}) });
      };
      child.once("exit", (code) => end(code ? `Codex stopped with code ${code}.` : undefined));
      // A program that fails to start can send no exit at all.
      child.once("error", () => end("Codex could not start."));

      try {
        const hello = await request("initialize", {
          clientInfo: { name: "scope", title: "Scope", version: "1" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        write({ method: "initialized" });
        const version = codexVersion(hello.userAgent);
        if (!version || !atLeast(version, MIN_CODEX)) {
          emit({ type: "blocked", reason: TOO_OLD });
          close();
          return { send: async () => {}, approve: () => {}, stop: () => {}, close: () => {} };
        }
        // Reading the account costs nothing. Chat runs only on a ChatGPT plan login.
        const { account } = (await request("account/read", {})) as {
          account?: { type?: string; planType?: string } | null;
        };
        if (account?.type !== "chatgpt") {
          emit({ type: "blocked", reason: BILLED_TO_KEY });
          close();
          return { send: async () => {}, approve: () => {}, stop: () => {}, close: () => {} };
        }
        emit({ type: "account", label: `${planLabel(account.planType ?? "ChatGPT")} plan` });
        const fresh = () =>
          request("thread/start", {
            cwd: folder,
            ...(tools ? { dynamicTools: dynamicTools(tools) } : {}),
          });
        let started: Record<string, unknown>;
        if (resume)
          try {
            started = await request("thread/resume", { threadId: resume, cwd: folder });
          } catch {
            emit({ type: "notice", text: RESUME_FAILED });
            started = await fresh();
          }
        else started = await fresh();
        threadId = String((started.thread as { id?: string } | undefined)?.id ?? "");
        if (!threadId) throw new Error("Codex did not start a conversation.");
        emit({ type: "session", id: threadId });
      } catch (error) {
        close();
        throw error;
      }

      return {
        send: async (message) => {
          const result = await request("turn/start", {
            threadId,
            input: [{ type: "text", text: message, text_elements: [] }],
          });
          const id = String((result.turn as { id?: string } | undefined)?.id ?? "");
          if (id === finished) return;
          turnId = id;
          // Stop was pressed before Codex said which turn it started.
          if (stopping && turnId)
            void request("turn/interrupt", { threadId, turnId }).catch(() => {});
        },
        approve: (id, allow) => approvals.get(id)?.(allow),
        stop: () => {
          stopping = true;
          for (const answer of approvals.values()) answer(false);
          if (turnId) void request("turn/interrupt", { threadId, turnId }).catch(() => {});
        },
        close,
      };
    },
  };
}
