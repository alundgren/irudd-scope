import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import { newCanvas, openCard, pane, seedCards } from "./canvas-fixture.ts";

const BILLED_TO_KEY = "This would be billed to your API key, so chat is off.";

type LogEntry =
  | { event: "start"; args: string[]; cwd: string }
  | { event: "control"; subtype: string }
  | { event: "message"; text: string; session: string }
  | { event: "approval"; tool: string; behavior: string }
  | { event: "exit" };

/**
 * A fake claude program under a made-up name, so Scope finds it the way it finds the real one
 * and no test can start the person's own claude.
 */
async function fakeClaude(login: "plan" | "api-key") {
  const directory = await mkdtemp(join(tmpdir(), "scope-fake-claude-"));
  const bin = join(directory, "bin");
  const temp = join(directory, "tmp");
  await mkdir(bin);
  await mkdir(temp);
  const name = `fnaude-${randomUUID().slice(0, 8)}`;
  const script = resolve("tests/fixtures/fake-claude/fake-claude.mjs");
  await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(join(bin, name), 0o755);
  const log = join(directory, "log.jsonl");
  const account = join(directory, "account");
  await writeFile(account, login);
  return {
    directory,
    account,
    folders: join(await realpath(temp), "scope-card-chats"),
    env: {
      SCOPE_CLAUDE_COMMAND: name,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_ACCOUNT_FILE: account,
      // Card chat folders go in the OS temp folder; this keeps each test's to itself.
      TMPDIR: temp,
    },
    async log(): Promise<LogEntry[]> {
      const text = await readFile(log, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogEntry);
    },
  };
}

const chatPage = (application: ElectronApplication) =>
  application.windows().find((page) => page.url() === "scope://app/chat.html");

async function openChat(application: ElectronApplication) {
  await expect.poll(() => chatPage(application) !== undefined).toBe(true);
  const chat = chatPage(application)!;
  await chat.getByRole("heading", { name: "Chat", exact: true }).waitFor();
  return chat;
}

async function setCardChat(page: Page, enabled: boolean) {
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

async function say(chat: Page, text: string) {
  const field = chat.getByLabel("Message", { exact: true });
  await expect.poll(() => field.isEnabled()).toBe(true);
  await field.fill(text);
  await field.press("Enter");
}

const turns = (chat: Page, label: string) => chat.getByRole("listitem", { name: label }).count();
const agentSaid = (chat: Page, text: string) =>
  chat.locator(".chat-message-agent").filter({ hasText: text }).waitFor();

test.skipIf(process.platform === "win32")(
  "card chat runs the person's claude only on a plan login, in the card's own folder, and only the chat panel can answer it",
  { tags: ["bad-requests-change-nothing"], timeout: 240_000 },
  async () => {
    const claude = await fakeClaude("api-key");
    const f = await desktopFixture({ hideInitialPrompts: true, env: claude.env });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Shop");
      const [cardId] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
      ]);
      await openCard(page, "Order flow");
      await setCardChat(page, true);
      const chat = await openChat(application);
      await chat.getByText("Ask about this card, or ask for changes to it.").waitFor();

      // An API key login is never used, and the check itself sends the program no message.
      await say(chat, "hello");
      await chat.getByRole("alert").filter({ hasText: BILLED_TO_KEY }).waitFor();
      expect(await chat.getByLabel("Message", { exact: true }).isDisabled()).toBe(true);
      await expect
        .poll(async () =>
          (await claude.log()).some(
            (entry) => entry.event === "control" && entry.subtype === "initialize",
          ),
        )
        .toBe(true);
      expect((await claude.log()).filter((entry) => entry.event === "message")).toEqual([]);

      // After signing in with a plan, opening the card again lets chat run.
      await writeFile(claude.account, "plan");
      await page.keyboard.press("Escape");
      await openCard(page, "Order flow");
      await say(chat, "hello");
      await agentSaid(chat, "Fake reply to: hello");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(1);
      await chat.getByText("Max plan", { exact: true }).waitFor();
      expect(await chat.getByRole("alert").count()).toBe(0);
      const starts = (await claude.log()).filter((entry) => entry.event === "start");
      expect(starts.at(-1)?.cwd).toBe(join(claude.folders, cardId));
      // Scope leaves the person's own tools, settings and MCP servers alone.
      for (const start of starts)
        for (const flag of ["--tools", "--setting-sources", "--strict-mcp-config"])
          expect(start.args.some((arg) => arg.startsWith(flag))).toBe(false);

      // A denied command is not run.
      await say(chat, "run a command");
      const command = chat.getByRole("listitem", { name: "Run a command?" });
      await command.getByRole("button", { name: "Deny", exact: true }).click();
      await agentSaid(chat, "I didn't run it.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(2);
      await command.getByText("Denied", { exact: true }).waitFor();

      // While a file change waits for an answer, a published page has no way to answer it.
      await say(chat, "write a file");
      const write = chat.getByRole("listitem", { name: "Change a file?" });
      await write.getByRole("button", { name: "Allow", exact: true }).waitFor();
      const before = (await claude.log()).length;
      const probe = join(f.directory, "probe.html");
      await writeFile(probe, "<!doctype html><title>Probe</title><p>Probe</p>");
      await f.cli("add", probe, "--id", "probe", "--title", "Probe");
      await page.getByRole("tab", { name: "Probe" }).click();
      const frame = (await page.locator('iframe[title="Probe"]').elementHandle())!.contentFrame();
      const reach = await (await frame)!.evaluate(() => {
        const parentBridge = (() => {
          try {
            const parent = window.parent as unknown as Record<string, object | undefined>;
            return {
              chat: "scopeChat" in parent,
              scope: Object.keys(parent.scope ?? {}).filter((key) => /chat/i.test(key)),
            };
          } catch {
            return "blocked";
          }
        })();
        return { scope: "scope" in window, chat: "scopeChat" in window, parentBridge };
      });
      // The workspace bridge the page can see only places the panel.
      expect(reach).toEqual({
        scope: false,
        chat: false,
        parentBridge: { chat: false, scope: ["chatLayout"] },
      });
      await page.getByRole("tab", { name: "Shop" }).click();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      await write.getByRole("button", { name: "Allow", exact: true }).waitFor();
      expect((await claude.log()).length).toBe(before);
      await write.getByRole("button", { name: "Allow", exact: true }).click();
      await agentSaid(chat, "I wrote notes.txt.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(3);
      expect((await claude.log()).filter((entry) => entry.event === "approval")).toEqual([
        { event: "approval", tool: "Bash", behavior: "deny" },
        { event: "approval", tool: "Write", behavior: "allow" },
      ]);

      // Stop ends a long turn.
      await say(chat, "count for a long time");
      await agentSaid(chat, "Counting slowly…");
      await chat.getByRole("button", { name: "Stop", exact: true }).click();
      await expect.poll(() => turns(chat, "Stopped")).toBe(1);
      expect(
        (await claude.log()).some(
          (entry) => entry.event === "control" && entry.subtype === "interrupt",
        ),
      ).toBe(true);
      // The fake ran one program for the whole conversation after the plan login.
      expect((await claude.log()).filter((entry) => entry.event === "start").length).toBe(2);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
      await rm(claude.directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a card chat continues after a restart, and its folder goes when the card is gone for good",
  { tags: ["survives-restart", "deletion-is-final"], timeout: 240_000 },
  async () => {
    const claude = await fakeClaude("plan");
    const f = await desktopFixture({ hideInitialPrompts: true, env: claude.env });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Shop");
      const [cardId] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
      ]);
      const folder = join(claude.folders, cardId);
      await openCard(page, "Order flow");
      await setCardChat(page, true);
      let chat = await openChat(application);
      await say(chat, "hello");
      await agentSaid(chat, "Fake reply to: hello");
      const session = (await claude.log()).find((entry) => entry.event === "message")!;
      expect(session).toMatchObject({ event: "message", text: "hello" });
      expect(existsSync(folder)).toBe(true);

      // Quitting during a turn leaves it interrupted; it does not continue by itself.
      await say(chat, "keep going forever");
      await agentSaid(chat, "Counting slowly…");
      await application.close();
      await rm(folder, { recursive: true, force: true });
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      chat = await openChat(application);
      await agentSaid(chat, "Fake reply to: hello");
      await expect.poll(() => turns(chat, "Interrupted when Scope quit")).toBe(1);

      // The next message continues the same conversation, in a folder made again.
      await say(chat, "and again");
      await agentSaid(chat, "Fake reply to: and again");
      const starts = (await claude.log()).filter((entry) => entry.event === "start");
      expect(starts.at(-1)?.args).toContain(`--resume=${(session as { session: string }).session}`);
      expect(existsSync(folder)).toBe(true);

      // Deleting the canvas for good removes the card's folder too.
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Shop" }).focus();
      await page.keyboard.press("Delete");
      await expect.poll(() => page.getByRole("tab", { name: "Shop" }).count()).toBe(0);
      expect(existsSync(folder)).toBe(true);
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await page.getByRole("button", { name: "Trashcan", exact: true }).click();
      await page.getByRole("button", { name: "Empty Trashcan…", exact: true }).click();
      const slider = page.getByRole("slider", { name: "Slide to enable deletion" });
      await expect
        .poll(() => slider.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("End");
      await page.getByRole("button", { name: "Delete 1 tab forever", exact: true }).click();
      await page.getByText("Trashcan is empty.", { exact: true }).waitFor();
      await expect.poll(() => existsSync(folder)).toBe(false);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
      await rm(claude.directory, { recursive: true, force: true });
    }
  },
);
