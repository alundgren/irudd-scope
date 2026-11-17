import { expect, test } from "vite-plus/test";
import { rm, writeFile } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import { newCanvas, openCard, pane, seedCards } from "./canvas-fixture.ts";
import {
  BILLED_TO_KEY,
  agentSaid,
  bothPrograms,
  chooseChat,
  fakeClaude,
  fakeCodex,
  inkedOver,
  openChat,
  running,
  say,
  setCardChat,
  turns,
} from "./card-chat-fixture.ts";

test.skipIf(process.platform === "win32")(
  "card chat runs the person's codex only on a ChatGPT plan login, with the model Settings chooses and Scope's card tools, and continues after a restart",
  { tags: ["bad-requests-change-nothing", "survives-restart"], timeout: 240_000 },
  async () => {
    const claude = await fakeClaude("plan");
    const codex = await fakeCodex("api-key");
    const f = await desktopFixture({
      hideInitialPrompts: true,
      env: { ...bothPrograms(claude, codex), SCOPE_TEST_MODEL_LIST_TIMEOUT: "5000" },
    });
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
      // Settings picks the program; Codex on an API key login offers no models and says why.
      await chooseChat(
        page,
        { program: "Codex" },
        "Codex isn't signed in with ChatGPT, so card chat can't use it.",
      );
      let chat = await openChat(application);
      await chat.getByText("Codex", { exact: true }).waitFor();
      // The panel only names what runs; it has no menus of its own.
      expect(await chat.getByRole("combobox").count()).toBe(0);
      const methods = async () =>
        (await codex.log()).flatMap((entry) => (entry.event === "request" ? [entry.method] : []));
      const reads = async () =>
        (await methods()).filter((method) => method === "account/read").length;
      const listed = await reads();

      // An API key login is never used, and the check sends codex no turn.
      await say(chat, "hello");
      await chat.getByRole("alert").filter({ hasText: BILLED_TO_KEY }).waitFor();
      expect(await chat.getByLabel("Message", { exact: true }).isDisabled()).toBe(true);
      await expect.poll(reads).toBeGreaterThan(listed);
      expect(await methods()).not.toContain("turn/start");
      expect(await methods()).not.toContain("thread/start");

      // After signing in with ChatGPT, opening the card again lets chat run. A codex that never
      // lists its models is stopped once Settings stops waiting for it.
      await writeFile(codex.account, "chatgpt");
      await codex.offer("never");
      await page.keyboard.press("Escape");
      await openCard(page, "Order flow");
      await chooseChat(page, {}, "Codex didn't list its models in time.");
      const listings = (await codex.log()).flatMap((entry) =>
        entry.event === "start" && entry.cwd === codex.listFolder ? [entry.pid] : [],
      );
      await expect.poll(() => running(listings.at(-1)!), { timeout: 5_000 }).toBe(false);
      await codex.offer(null);
      await chooseChat(page, { model: "Fake Terra", reasoning: "High", speed: "Fast" });
      await chat.getByText("Codex · Fake Terra · high · fast", { exact: true }).waitFor();
      await codex.script({
        note: [
          { call: "read_diagram" },
          {
            call: "edit_diagram",
            arguments: {
              version: "@version",
              requestId: "note-1",
              changes: [{ action: "add", text: "Checkout", x: 40, y: 40 }],
            },
          },
          { call: "read_diagram" },
          { say: "Added Checkout." },
        ],
      });
      await say(chat, "add a note about checkout");
      await pane(page).locator('.boxes-agent[aria-label="Checkout"]').waitFor();
      await agentSaid(chat, "Added Checkout.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(1);
      await chat.getByText("Pro plan", { exact: true }).waitFor();
      expect(await chat.getByRole("alert").count()).toBe(0);
      expect(await chat.locator(".chat-tool-name").allTextContents()).toEqual([
        "Read card",
        "Change card",
        "Read card",
      ]);
      // Reading the empty card brings no picture; reading it again brings a PNG of Checkout.
      const pictureReads = (await codex.log()).flatMap((entry) =>
        entry.event === "tool-result" && entry.tool === "read_diagram" ? [entry] : [],
      );
      expect(pictureReads.map((entry) => entry.content)).toEqual([
        ["inputText"],
        ["inputText", "inputImage"],
      ]);
      expect(JSON.parse(pictureReads[0].text)).toMatchObject({
        picture: "None, because the card is empty.",
      });
      expect(JSON.parse(pictureReads[1].text)).toMatchObject({
        picture: { width: 208, height: 128, scale: 1, left: 16, top: 16 },
        boxes: [{ text: "Checkout", x: 40, y: 40, w: 160, h: 80 }],
      });
      expect(pictureReads[1].image).toMatchObject({
        mimeType: "image/png",
        png: true,
        width: 208,
        height: 128,
      });
      expect(
        inkedOver(pictureReads[1].image!.ink, JSON.parse(pictureReads[1].text).picture, {
          x: 40,
          y: 40,
          w: 160,
          h: 80,
        }),
      ).toBe(true);
      const messages = async () =>
        (await codex.log()).flatMap((entry) => (entry.event === "message" ? [entry] : []));
      expect((await messages()).at(-1)).toMatchObject({
        text: "add a note about checkout",
        model: "fake-terra",
        effort: "high",
        serviceTier: "priority",
      });
      const threads = async () =>
        (await codex.log()).flatMap((entry) => (entry.event === "thread" ? [entry] : []));
      const [started] = await threads();
      expect(started).toMatchObject({
        method: "thread/start",
        cwd: await codex.folder(cardId),
        tools: ["read_diagram", "edit_diagram"],
      });

      // A new choice applies from the next message: Fake Luna has no fast speed, and keeps no
      // reasoning level it doesn't offer.
      await chooseChat(page, { model: "Fake Luna" });
      await chat.getByText("Codex · Fake Luna · medium", { exact: true }).waitFor();

      // A denied command is not run; an allowed file change is.
      await say(chat, "run a command");
      const command = chat.getByRole("listitem", { name: "Run a command?" });
      await command.getByRole("button", { name: "Deny", exact: true }).click();
      await agentSaid(chat, "I didn't run it.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(2);
      await command.getByText("Denied", { exact: true }).waitFor();
      expect((await messages()).at(-1)).toMatchObject({
        text: "run a command",
        model: "fake-luna",
        effort: "medium",
        serviceTier: null,
      });
      await say(chat, "write a file");
      const write = chat.getByRole("listitem", { name: "Change a file?" });
      await write.getByRole("button", { name: "Allow", exact: true }).click();
      await agentSaid(chat, "I wrote notes.txt.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(3);
      expect((await codex.log()).filter((entry) => entry.event === "decision")).toEqual([
        { event: "decision", kind: "command", decision: "decline" },
        { event: "decision", kind: "file", decision: "accept" },
      ]);

      // Stop ends a long turn.
      await say(chat, "count for a long time");
      await agentSaid(chat, "Counting slowly…");
      await chat.getByRole("button", { name: "Stop", exact: true }).click();
      await expect.poll(() => turns(chat, "Stopped")).toBe(1);
      expect(await methods()).toContain("turn/interrupt");

      // Stop pressed before codex answers turn/start still stops the turn.
      await say(chat, "a slow long one");
      await chat.getByRole("button", { name: "Stop", exact: true }).click();
      await expect.poll(() => turns(chat, "Stopped"), { timeout: 10_000 }).toBe(2);

      // A helper agent finishing on its own thread does not end the chat's turn.
      await say(chat, "ask a helper");
      await agentSaid(chat, "The helper finished.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(4);

      // Closing the card's editor stops a running turn too.
      await say(chat, "count for a long time again");
      const counting = chat.locator(".chat-message-agent").filter({ hasText: "Counting slowly…" });
      await expect.poll(() => counting.count()).toBe(3);
      await page.keyboard.press("Escape");
      await openCard(page, "Order flow");
      await expect.poll(() => turns(chat, "Stopped")).toBe(3);
      expect(await turns(chat, "Turn finished")).toBe(4);

      // After a restart, the next message continues the same codex thread. Codex no longer
      // offers the saved model, so Settings, the header and the message use its default model.
      await codex.offer(["fake-terra"]);
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      chat = await openChat(application);
      await agentSaid(chat, "Added Checkout.");
      await chat.getByText("Codex · Fake Luna · medium", { exact: true }).waitFor();
      expect(await chooseChat(page, {})).toEqual({
        program: "Codex",
        model: "Fake Terra",
        reasoning: "Low",
        speed: "Standard",
      });
      await chat.getByText("Codex · Fake Terra · low", { exact: true }).waitFor();
      await say(chat, "and again");
      await agentSaid(chat, "Fake reply to: and again");
      const resumed = (await threads()).at(-1);
      expect(resumed).toMatchObject({ method: "thread/resume", thread: started.thread });
      expect((await threads()).filter((entry) => entry.method === "thread/start")).toHaveLength(1);
      expect((await messages()).at(-1)).toMatchObject({
        text: "and again",
        model: "fake-terra",
        effort: "low",
        serviceTier: null,
      });

      // Choosing Claude Code in Settings starts a new conversation with it.
      await chooseChat(page, { program: "Claude Code" });
      await chat.getByText("Claude Code · Fake Opus", { exact: true }).waitFor();
      const sent = (await messages()).length;
      await say(chat, "hello claude");
      await agentSaid(chat, "Fake reply to: hello claude");
      const told = (await claude.log()).flatMap((entry) =>
        entry.event === "message" ? [entry.text] : [],
      );
      expect(told).toEqual(["hello claude"]);
      expect(await messages()).toHaveLength(sent);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
      await rm(codex.directory, { recursive: true, force: true });
      await rm(claude.directory, { recursive: true, force: true });
    }
  },
);
