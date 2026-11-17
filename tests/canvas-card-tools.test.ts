import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import {
  cardContent,
  cardHistory,
  center,
  drag,
  editorPoint,
  newCanvas,
  openCard,
  pane,
  records,
  seedCards,
  seedContent,
} from "./canvas-fixture.ts";
import { agentSaid, fakeClaude, openChat, say, setCardChat, turns } from "./card-chat-fixture.ts";

const box = (x: number, y: number, text: string, z: string) => ({
  type: "box",
  x,
  y,
  w: 160,
  h: 80,
  text,
  z,
});

type Claude = Awaited<ReturnType<typeof fakeClaude>>;
const toolResults = async (claude: Claude) =>
  (await claude.log()).flatMap((entry) => (entry.event === "tool-result" ? [entry] : []));

test.skipIf(process.platform === "win32")(
  "the chat's claude edits the open card with Scope's card tools, and a retried edit applies once",
  { tags: ["no-lost-updates"], timeout: 240_000 },
  async () => {
    const claude = await fakeClaude("plan");
    const f = await desktopFixture({ hideInitialPrompts: true, env: claude.env });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Shop");
      const [cardId] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
      ]);
      const seeded = await seedContent(page, tabId, cardId, "Seed", [
        { op: "put", id: "$web", value: box(0, 0, "Web app", "a1") },
        { op: "put", id: "$db", value: box(0, 140, "Orders DB", "a2") },
      ]);
      await openCard(page, "Order flow");
      await setCardChat(page, true);
      const chat = await openChat(application);

      const edit = {
        version: "@version",
        requestId: "cache-1",
        changes: [
          {
            action: "add",
            ref: "cache",
            text: "Redis",
            kind: "database",
            near: "@id:Web app",
            side: "below",
          },
          { action: "connect", from: "@id:Web app", to: "$cache", label: "reads" },
        ],
      };
      await claude.script({
        cache: [
          { call: "read_diagram" },
          { call: "edit_diagram", arguments: edit },
          // The same call again, as after a lost answer, and then the same requestId reused.
          { call: "edit_diagram", arguments: edit },
          {
            call: "edit_diagram",
            arguments: { ...edit, changes: [{ action: "add", text: "Other" }] },
          },
          { say: "Added a cache." },
        ],
      });
      await say(chat, "add a cache below the web app");
      await pane(page).locator('.boxes-agent[aria-label="Redis"]').waitFor();
      await agentSaid(chat, "Added a cache.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(1);

      // The card tools came from Scope's server and never asked the person.
      const log = await claude.log();
      expect(log.find((entry) => entry.event === "tools")).toEqual({
        event: "tools",
        names: ["read_diagram", "edit_diagram"],
      });
      expect(log.flatMap((entry) => (entry.event === "approval" ? [entry.behavior] : []))).toEqual([
        "allow",
        "allow",
        "allow",
        "allow",
      ]);
      expect(await chat.locator(".chat-card").count()).toBe(1);
      expect(await chat.locator(".chat-tool-name").allTextContents()).toEqual([
        "Read card",
        "Change card",
        "Change card",
        "Change card",
      ]);

      const [read, first, again, reused] = await toolResults(claude);
      expect(read.isError).toBe(false);
      expect(JSON.parse(read.text)).toMatchObject({
        title: "Order flow",
        boxes: [
          { id: seeded.$web, text: "Web app" },
          { id: seeded.$db, text: "Orders DB" },
        ],
      });
      const answer = JSON.parse(first.text) as {
        refs: Record<string, string>;
        warnings: string[];
      };
      expect(first.isError).toBe(false);
      expect(answer.warnings).toEqual([
        "Placed Redis 80 lower than asked so it does not cover Orders DB.",
      ]);
      expect(again).toEqual(first);
      expect(reused.isError).toBe(true);
      expect(reused.text).toContain("already used for a different change");

      const content = await cardContent(page, tabId, cardId);
      const cache = answer.refs.cache;
      expect(Object.keys(content)).toHaveLength(4);
      expect(content[cache]).toMatchObject({
        type: "box",
        kind: "database",
        text: "Redis",
        x: 0,
        y: 220,
        w: 160,
        h: 80,
      });
      expect(records(content, "connector").map(([, record]) => record)).toMatchObject([
        { from: { id: seeded.$web }, to: { id: cache }, label: "reads" },
      ]);
      // One step for the seed and one for the agent's change; the retry added nothing.
      expect(cardHistory(f.settingsDirectory, tabId, cardId)).toBe(2);

      // The turn lists what it changed, and Undo turn takes it all back.
      const turn = chat.getByRole("listitem", { name: "Turn finished" });
      await turn.getByText("Added Redis", { exact: true }).waitFor();
      await turn.getByText("Connected Web app to Redis", { exact: true }).waitFor();
      await turn.getByRole("button", { name: "Undo turn", exact: true }).click();
      await turn.getByText("Undone", { exact: true }).waitFor();
      await expect
        .poll(async () => Object.keys(await cardContent(page, tabId, cardId)).sort())
        .toEqual([seeded.$web, seeded.$db].sort());
      await pane(page).getByRole("button", { name: "Redis", exact: true }).waitFor({
        state: "detached",
      });
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
      await rm(claude.directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "undoing an agent's turn keeps what the person changed since, and stale agent edits are refused",
  { tags: ["no-lost-updates"], timeout: 240_000 },
  async () => {
    const claude = await fakeClaude("plan");
    const f = await desktopFixture({ hideInitialPrompts: true, env: claude.env });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Shop");
      const [cardId] = await seedCards(page, tabId, [
        { title: "Checkout", x: 0, y: 0, w: 640, h: 400 },
      ]);
      const seeded = await seedContent(page, tabId, cardId, "Seed", [
        { op: "put", id: "$api", value: box(0, 0, "API", "a1") },
        { op: "put", id: "$pay", value: box(400, 0, "Payments", "a2") },
      ]);
      const api = seeded.$api;
      const content = () => cardContent(page, tabId, cardId);
      await openCard(page, "Checkout");
      await setCardChat(page, true);
      const chat = await openChat(application);

      // One agent turn of two edits: add Queue with its connector, then move API.
      await claude.script({
        queue: [
          { call: "read_diagram" },
          {
            call: "edit_diagram",
            arguments: {
              changes: [
                { action: "add", ref: "q", text: "Queue", kind: "queue", near: "@id:API" },
                { action: "connect", from: "@id:API", to: "$q" },
              ],
            },
          },
          {
            call: "edit_diagram",
            arguments: { changes: [{ action: "update", id: "@id:API", x: 40 }] },
          },
          { say: "Added a queue." },
        ],
      });
      await say(chat, "add a queue");
      await agentSaid(chat, "Added a queue.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(1);
      const queue = (
        JSON.parse((await toolResults(claude))[1].text) as { refs: Record<string, string> }
      ).refs.q;
      expect((await content())[api]).toMatchObject({ x: 40 });
      expect(Object.keys(await content())).toHaveLength(4);

      // Then the person drags API.
      const editor = pane(page);
      const origin = await editorPoint(page, 0, 0);
      const right = await editorPoint(page, 500, 0);
      await drag(
        page,
        await center(page, editor.getByRole("button", { name: "API", exact: true })),
        right.x - origin.x,
        0,
      );
      await expect.poll(async () => (await content())[api].x).not.toBe(40);
      const moved = (await content())[api].x as number;
      expect(moved).toBeGreaterThan(200);

      // Ctrl+Z undoes only the person's drag; the agent's turn stays.
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await content())[api].x).toBe(40);
      expect(Object.keys(await content())).toHaveLength(4);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(async () => (await content())[api].x).toBe(moved);

      // Undo turn removes Queue and its connector and leaves API where the person put it.
      const turn = chat.getByRole("listitem", { name: "Turn finished" });
      await turn.getByRole("button", { name: "Undo turn", exact: true }).click();
      await turn.getByText("Undone", { exact: true }).waitFor();
      await chat.getByText("Kept API where you moved it.", { exact: true }).waitFor();
      const undone = await content();
      expect(Object.keys(undone).sort()).toEqual([api, seeded.$pay].sort());
      expect(undone[api]).toMatchObject({ x: moved, text: "API" });

      // Edits made from the version read before all that: only untouched fields go through.
      await claude.script({
        check: [
          {
            call: "edit_diagram",
            arguments: {
              version: "@version",
              changes: [{ action: "update", id: "@id:Payments", text: "Payments service" }],
            },
          },
          {
            call: "edit_diagram",
            arguments: {
              version: "@version",
              changes: [{ action: "update", id: "@id:API", x: 600 }],
            },
          },
          {
            call: "edit_diagram",
            arguments: {
              version: "@version",
              changes: [{ action: "connect", from: "@id:API", to: queue }],
            },
          },
          { say: "Checked." },
        ],
      });
      await say(chat, "check the old version");
      await agentSaid(chat, "Checked.");
      await expect.poll(() => turns(chat, "Turn finished")).toBe(2);
      const [renamed, clash, gone] = (await toolResults(claude)).slice(-3);
      expect(renamed.isError).toBe(false);
      expect(clash.isError).toBe(true);
      expect(clash.text).toContain(`${api}.x changed since`);
      expect(clash.text).toContain(`it is now ${moved}`);
      expect(gone.isError).toBe(true);
      expect(gone.text).toContain(`There is no record ${queue}`);
      const after = await content();
      expect(Object.keys(after).sort()).toEqual([api, seeded.$pay].sort());
      expect(after[api]).toMatchObject({ x: moved });
      expect(after[seeded.$pay]).toMatchObject({ text: "Payments service" });
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
      await rm(claude.directory, { recursive: true, force: true });
    }
  },
);
