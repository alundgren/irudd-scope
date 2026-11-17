import { expect } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

export const BILLED_TO_KEY = "This would be billed to your API key, so chat is off.";

export type LogEntry =
  | { event: "start"; args: string[]; cwd: string; pid: number }
  | {
      event: "control";
      subtype: string;
      model?: string | null;
      settings?: Record<string, unknown>;
    }
  | {
      event: "message";
      text: string;
      session?: string;
      thread?: string;
      model?: string | null;
      effort?: string | null;
      serviceTier?: string | null;
    }
  | { event: "approval"; tool: string; behavior: string }
  | { event: "decision"; kind: "command" | "file"; decision: string }
  | { event: "request"; method: string }
  | { event: "thread"; method: string; thread: string; cwd: string; tools: string[] }
  | { event: "tools"; names: string[] }
  | {
      event: "tool-result";
      tool: string;
      text: string;
      isError: boolean;
      /** The answer's content types, in order. */
      content: string[];
      /** What the answer's picture is, read from its PNG header. */
      image?: { mimeType: string; png: boolean; width: number; height: number; ink: string[] };
    }
  | { event: "exit" };

/** A turn the fake plays: card tool calls and replies, as fake-claude.mjs describes. */
export type ScriptStep =
  | { call: "read_diagram" }
  | { call: "edit_diagram"; arguments: Record<string, unknown> }
  | { say: string }
  | { waitFor: string };

/**
 * A fake agent program under a made-up name, so Scope finds it the way it finds the real one
 * and no test can start the person's own claude or codex.
 */
async function fakeProgram(kind: "claude" | "codex", login: string) {
  const directory = await mkdtemp(join(tmpdir(), `scope-fake-${kind}-`));
  const bin = join(directory, "bin");
  const temp = join(directory, "tmp");
  await mkdir(bin);
  await mkdir(temp);
  const name = `${kind === "claude" ? "fnaude" : "fnodex"}-${randomUUID().slice(0, 8)}`;
  const program = resolve(`tests/fixtures/fake-${kind}/fake-${kind}.mjs`);
  await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`);
  await chmod(join(bin, name), 0o755);
  const log = join(directory, "log.jsonl");
  const account = join(directory, "account");
  await writeFile(account, login);
  const models = join(directory, "models.json");
  const turnsFile = join(directory, "script.json");
  await writeFile(turnsFile, "{}");
  const prefix = kind === "claude" ? "FAKE_CLAUDE" : "FAKE_CODEX";
  const programs = join(await realpath(temp), "scope-card-chats");
  return {
    directory,
    account,
    /** The one folder Scope made for a card's chat; its name ends in a tag for the profile. */
    async folder(cardId: string) {
      const names = (await readdir(programs)).filter((name) => name.startsWith(`${cardId}-`));
      expect(names).toHaveLength(1);
      return join(programs, names[0]);
    },
    /** Where Settings starts the program to list its models. */
    listFolder: programs,
    env: {
      [kind === "claude" ? "SCOPE_CLAUDE_COMMAND" : "SCOPE_CODEX_COMMAND"]: name,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      [`${prefix}_LOG`]: log,
      [`${prefix}_ACCOUNT_FILE`]: account,
      [`${prefix}_SCRIPT`]: turnsFile,
      [`${prefix}_MODELS_FILE`]: models,
      // Settings asks the programs again when it opens, at most this often.
      SCOPE_TEST_MODEL_LIST_COOLDOWN: "500",
      // Card chat folders go in the OS temp folder; this keeps each test's to itself.
      TMPDIR: temp,
    },
    /** The models the fake codex offers by ID, all of them with null, or "never" to not answer. */
    offer: (ids: string[] | "never" | null) =>
      ids ? writeFile(models, JSON.stringify(ids)) : rm(models, { force: true }),
    /** Sets the turns the fake plays, chosen by words in the person's message. */
    script: (turns: Record<string, ScriptStep[]>) => writeFile(turnsFile, JSON.stringify(turns)),
    async log(): Promise<LogEntry[]> {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogEntry);
    },
  };
}

export const fakeClaude = (login: "plan" | "api-key") => fakeProgram("claude", login);
export const fakeCodex = (login: "chatgpt" | "api-key") => fakeProgram("codex", login);

export const chatPage = (application: ElectronApplication) =>
  application.windows().find((page) => page.url() === "scope://app/chat.html");

export async function openChat(application: ElectronApplication) {
  await expect.poll(() => chatPage(application) !== undefined).toBe(true);
  const chat = chatPage(application)!;
  await chat.getByRole("heading", { name: "Chat", exact: true }).waitFor();
  return chat;
}

export async function setCardChat(page: Page, enabled: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Search settings").fill("card chat");
  const toggle = page.getByRole("switch", { name: "Card chat", exact: true });
  await toggle.focus();
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled))
    await page.keyboard.press("Space");
  await expect.poll(() => toggle.getAttribute("aria-checked")).toBe(String(enabled));
  await page.keyboard.press("Escape");
  await page.getByLabel("Search settings").waitFor({ state: "detached" });
}

/** Settings choices for card chat, by the names the menus show. */
export type ChatChoice = { program?: string; model?: string; reasoning?: string; speed?: string };

/**
 * Opens Card chat in Settings, waits for the programs' models, and picks each choice in turn.
 * Answers what the menus showed before any pick.
 */
export async function chooseChat(page: Page, choice: ChatChoice, expectText?: string) {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("Search settings").fill("card chat");
  await page.getByRole("combobox", { name: "Program", exact: true }).waitFor();
  if (expectText) await page.getByText(expectText, { exact: true }).waitFor();
  const shown: ChatChoice = {};
  for (const [key, name] of [
    ["program", "Program"],
    ["model", "Model"],
    ["reasoning", "Reasoning"],
    ["speed", "Speed"],
  ] as const) {
    const menu = page.getByRole("combobox", { name, exact: true });
    if (await menu.count())
      shown[key] = await menu.evaluate(
        (element: HTMLSelectElement) => element.selectedOptions[0]?.text,
      );
  }
  const menus = [
    ["Program", choice.program],
    ["Model", choice.model],
    ["Reasoning", choice.reasoning],
    ["Speed", choice.speed],
  ] as const;
  for (const [name, label] of menus) {
    if (!label) continue;
    const menu = page.getByRole("combobox", { name, exact: true });
    await menu.selectOption({ label });
    // The menu shows the saved choice, so this waits for the save.
    await expect
      .poll(() => menu.evaluate((element: HTMLSelectElement) => element.selectedOptions[0]?.text))
      .toBe(label);
  }
  await page.keyboard.press("Escape");
  await page.getByLabel("Search settings").waitFor({ state: "detached" });
  return shown;
}

/** Whether a process is still running, such as a fake program Scope started. */
export function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Both fake programs at once, so Settings can switch between them. */
export function bothPrograms(
  first: { env: Record<string, string> },
  second: { env: Record<string, string> },
) {
  const own = (env: Record<string, string>) => env.PATH.split(delimiter)[0];
  return {
    ...first.env,
    ...second.env,
    PATH: [own(first.env), own(second.env), process.env.PATH ?? ""].join(delimiter),
  };
}

export async function say(chat: Page, text: string) {
  const field = chat.getByLabel("Message", { exact: true });
  await expect.poll(() => field.isEnabled()).toBe(true);
  await field.fill(text);
  await field.press("Enter");
}

export const turns = (chat: Page, label: string) =>
  chat.getByRole("listitem", { name: label }).count();
export const agentSaid = (chat: Page, text: string) =>
  chat.locator(".chat-message-agent").filter({ hasText: text }).waitFor();

type Picture = { width: number; height: number; scale: number; left: number; top: number };

/** Whether a picture from read_diagram has ink over the card area `item` covers. */
export function inkedOver(
  ink: string[],
  picture: Picture,
  item: { x: number; y: number; w: number; h: number },
) {
  const cells = ink.length;
  const column = (x: number) =>
    Math.min(cells - 1, Math.floor((((x - picture.left) * picture.scale) / picture.width) * cells));
  const row = (y: number) =>
    Math.min(cells - 1, Math.floor((((y - picture.top) * picture.scale) / picture.height) * cells));
  for (let y = row(item.y); y <= row(item.y + item.h); y++)
    if (ink[y].slice(column(item.x), column(item.x + item.w) + 1).includes("1")) return true;
  return false;
}

/** How many cells of a picture's ink grid have ink. */
export const inkedCells = (ink: string[]) => ink.join("").split("1").length - 1;
