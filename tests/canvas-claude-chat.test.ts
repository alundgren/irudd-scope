import { expect, test } from "vite-plus/test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { cardContent, newCanvas, openCard, pane, seedCards } from "./canvas-fixture.ts";
import {
  BILLED_TO_KEY,
  agentSaid,
  chooseChat,
  fakeClaude,
  openChat,
  say,
  setCardChat,
  turns,
} from "./card-chat-fixture.ts";

test.skipIf(process.platform === "win32")(
  "card chat runs the person's claude only on a plan login, with the model Settings chooses, in the card's own folder, and only the chat panel can answer it",
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
      // Settings says why Claude Code on an API key login offers no models.
      await chooseChat(
        page,
        {},
        "Claude Code isn't signed in with a Claude plan, so card chat can't use it.",
      );
      const chat = await openChat(application);
      await chat.getByText("Ask about this card, or ask for changes to it.").waitFor();
      expect(await chat.getByRole("combobox").count()).toBe(0);

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
      await chooseChat(page, { model: "Fake Opus", reasoning: "Max", speed: "Fast" });
      await chat.getByText("Claude Code · Fake Opus · max · fast", { exact: true }).waitFor();
      await say(chat, "hello");
      await agentSaid(chat, "Fake reply to: hello");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(1);
      await chat.getByText("Max plan", { exact: true }).waitFor();
      expect(await chat.getByRole("alert").count()).toBe(0);
      // Settings starts the program in another folder to list its models.
      const folder = await claude.folder(cardId);
      const chatStarts = async () =>
        (await claude.log()).flatMap((entry) =>
          entry.event === "start" && entry.cwd === folder ? [entry] : [],
        );
      const starts = await chatStarts();
      const args = starts.at(-1)!.args;
      expect(args).toEqual(expect.arrayContaining(["--model=fake-opus", "--effort=max"]));
      expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({ fastMode: true });
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
      // The workspace bridge the page can see only places the panel and lists models for Settings.
      expect(reach).toEqual({
        scope: false,
        chat: false,
        parentBridge: { chat: false, scope: ["cardChatPrograms", "chatLayout"] },
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

      // A new choice applies from the next message: Fake Haiku has no reasoning levels or fast mode.
      await chooseChat(page, { model: "Fake Haiku" });
      await chat.getByText("Claude Code · Fake Haiku", { exact: true }).waitFor();
      const controls = async () =>
        (await claude.log()).filter(
          (entry) =>
            entry.event === "control" &&
            ["set_model", "apply_flag_settings"].includes(entry.subtype),
        );
      expect(await controls()).toEqual([]);

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
      expect(await controls()).toEqual([
        { event: "control", subtype: "set_model", model: "fake-haiku" },
        {
          event: "control",
          subtype: "apply_flag_settings",
          settings: { effortLevel: null, fastMode: false },
        },
      ]);
      // The fake ran one program for the whole conversation after the plan login.
      expect(await chatStarts()).toHaveLength(2);
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
      await openCard(page, "Order flow");
      await setCardChat(page, true);
      let chat = await openChat(application);
      await say(chat, "hello");
      await agentSaid(chat, "Fake reply to: hello");
      const session = (await claude.log()).find((entry) => entry.event === "message")!;
      expect(session).toMatchObject({ event: "message", text: "hello" });
      const folder = await claude.folder(cardId);

      // Quitting during a turn leaves it interrupted; it does not continue by itself.
      await claude.script({
        forever: [
          { call: "edit_diagram", arguments: { changes: [{ action: "add", text: "Draft" }] } },
          { say: "Counting slowly…" },
          { waitFor: join(claude.directory, "never") },
        ],
      });
      await say(chat, "keep going forever");
      await agentSaid(chat, "Counting slowly…");
      await expect
        .poll(async () => Object.keys(await cardContent(page, tabId, cardId)))
        .toHaveLength(1);
      await application.close();
      await rm(folder, { recursive: true, force: true });
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      chat = await openChat(application);
      await agentSaid(chat, "Fake reply to: hello");
      await expect.poll(() => turns(chat, "Interrupted when Scope quit")).toBe(1);
      // What the turn showed and changed before the quit is still there, and can be undone.
      await agentSaid(chat, "Counting slowly…");
      const interrupted = chat.getByRole("listitem", { name: "Interrupted when Scope quit" });
      await interrupted.getByRole("button", { name: "Undo turn", exact: true }).click();
      await interrupted.getByText("Undone", { exact: true }).waitFor();
      expect(await cardContent(page, tabId, cardId)).toEqual({});

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
