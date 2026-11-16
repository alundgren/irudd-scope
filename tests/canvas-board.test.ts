import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopFixture } from "./desktop-fixture.ts";
import { board, drag, newCanvas, pane } from "./canvas-fixture.ts";

async function addCard(page: Page, title: string) {
  await pane(page).getByRole("button", { name: "Add card", exact: true }).click();
  await page.getByRole("menuitem", { name: "Boxes and arrows", exact: true }).click();
  const card = page.getByRole("group", { name: "Boxes and arrows", exact: true });
  await card.locator(".canvas-card-title").dblclick();
  await page.getByLabel("Card title", { exact: true }).fill(title);
  await page.keyboard.press("Enter");
  await page.getByRole("group", { name: title, exact: true }).waitFor();
}

/** Resizes and moves a card through the board at zoom 1 until it has the given frame. */
async function placeCard(
  page: Page,
  tabId: string,
  title: string,
  frame: { x: number; y: number; w: number; h: number },
) {
  const id = Object.entries(await board(page, tabId)).find(([, card]) => card.title === title)![0];
  const card = page.getByRole("group", { name: title, exact: true });
  const start = (await board(page, tabId))[id];
  const corner = (await card.locator(".canvas-card-resize").boundingBox())!;
  await drag(
    page,
    { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 },
    frame.w - start.w,
    frame.h - start.h,
  );
  await expect.poll(async () => (await board(page, tabId))[id].w).toBe(frame.w);
  const bar = (await card.locator(".canvas-card-title").boundingBox())!;
  await drag(
    page,
    { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 },
    frame.x - start.x,
    frame.y - start.y,
  );
  await expect.poll(async () => (await board(page, tabId))[id]).toMatchObject(frame);
  return id;
}

function canvasRows(settingsDirectory: string, tabId: string) {
  const db = new DatabaseSync(join(settingsDirectory, "artifacts/scope.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return ["canvas_boards", "canvas_cards", "canvas_history", "canvas_ids"].map((table) =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tab_id = ?`).get(tabId)?.n),
    );
  } finally {
    db.close();
  }
}

test(
  "a canvas keeps its cards across restart and Trashcan, and emptying Trashcan removes it",
  { tags: ["survives-restart", "deletion-is-final"], timeout: 180_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Checkout");
      await page.getByText("Add a card to start this canvas.").waitFor();
      await addCard(page, "Order flow");
      const order = await placeCard(page, tabId, "Order flow", { x: 0, y: 0, w: 640, h: 400 });
      await addCard(page, "Payment states");
      const payment = await placeCard(page, tabId, "Payment states", {
        x: 720,
        y: 0,
        w: 480,
        h: 360,
      });
      // Restack twice so Payment states ends above Order flow.
      await page.getByRole("button", { name: "Send to back", exact: true }).click();
      await expect
        .poll(async () => {
          const cards = await board(page, tabId);
          return cards[payment].z < cards[order].z;
        })
        .toBe(true);
      await page.getByRole("button", { name: "Bring to front", exact: true }).click();
      await expect
        .poll(async () => {
          const cards = await board(page, tabId);
          return cards[payment].z > cards[order].z;
        })
        .toBe(true);
      // The person's own Ctrl+Z steps back through board changes, and redo puts them back.
      await page.getByLabel("Canvas board", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => {
          const cards = await board(page, tabId);
          return cards[payment].z < cards[order].z;
        })
        .toBe(true);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect
        .poll(async () => {
          const cards = await board(page, tabId);
          return cards[payment].z > cards[order].z;
        })
        .toBe(true);
      const surface = (await page.getByLabel("Canvas board", { exact: true }).boundingBox())!;
      await page.mouse.move(surface.x + surface.width - 40, surface.y + surface.height - 40);
      await page.mouse.wheel(40, 30);
      if (process.env.SCOPE_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, "canvas-board.png"),
        });
      const saved = await board(page, tabId);
      expect(Object.keys(saved)).toHaveLength(2);
      expect(saved[order]).toMatchObject({ title: "Order flow", x: 0, y: 0, w: 640, h: 400 });

      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("tab", { name: "Checkout", selected: true }).waitFor();
      await page.getByRole("group", { name: "Payment states", exact: true }).waitFor();
      expect(await board(page, tabId)).toEqual(saved);
      const frames = await page
        .locator(".canvas-card")
        .evaluateAll((cards) =>
          cards.map((card) => (card as HTMLElement).getAttribute("aria-label")),
        );
      expect(frames).toEqual(["Order flow", "Payment states"]);

      // Trash keeps the canvas; restoring brings it back unchanged.
      await page.getByRole("tab", { name: "Checkout" }).focus();
      await page.keyboard.press("Delete");
      await expect.poll(() => page.getByRole("tab", { name: "Checkout" }).count()).toBe(0);
      expect(canvasRows(f.settingsDirectory, tabId)[1]).toBe(2);
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await page.getByRole("button", { name: "Trashcan", exact: true }).click();
      await page.locator("[data-tab-result]").filter({ hasText: "Checkout" }).click();
      await page.getByRole("tab", { name: "Checkout", selected: true }).waitFor();
      await page.getByRole("group", { name: "Order flow", exact: true }).waitFor();
      expect(await board(page, tabId)).toEqual(saved);

      await page.getByRole("tab", { name: "Checkout" }).focus();
      await page.keyboard.press("Delete");
      await expect.poll(() => page.getByRole("tab", { name: "Checkout" }).count()).toBe(0);
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
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      expect(canvasRows(f.settingsDirectory, tabId)).toEqual([0, 0, 0, 0]);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "a database from before canvases upgrades without losing a saved plan",
  { tags: ["survives-restart"], timeout: 120_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      const example = resolve(".agents/skills/irudd-scope/examples/plans/ui");
      await f.cli(
        "plan",
        "publish",
        "kept-plan",
        join(example, "plan.json"),
        join(example, "overview.html"),
      );
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).waitFor();
      await application.close();

      // Recreate the schema the previous release left: no canvas tables, user_version 18.
      const db = new DatabaseSync(join(f.settingsDirectory, "artifacts", "scope.db"));
      try {
        db.exec(
          "DROP TABLE canvas_ids; DROP TABLE canvas_history; DROP TABLE canvas_cards; DROP TABLE canvas_boards; PRAGMA user_version = 18;",
        );
      } finally {
        db.close();
      }

      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).click();
      await page.getByRole("button", { name: "Work items", exact: true }).waitFor();
      const tabId = await newCanvas(page, "After upgrade");
      await addCard(page, "Kept card");
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("tab", { name: "After upgrade", selected: true }).waitFor();
      await page.getByRole("group", { name: "Kept card", exact: true }).waitFor();
      expect(canvasRows(f.settingsDirectory, tabId).slice(0, 2)).toEqual([1, 1]);
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).click();
      await page.getByRole("button", { name: "Work items", exact: true }).waitFor();
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "canvas changes keep IDs to one record, undo a set and delete exactly, and answer late retries",
  { tags: ["bad-requests-change-nothing"], timeout: 120_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Rules");
      const outcome = await page.evaluate(async (tabId) => {
        const id = () => crypto.randomUUID().replaceAll("-", "");
        const version = async () => (await window.scope.canvasRead(tabId))!.board.version;
        const change = async (ops: unknown[], requestId = id()) =>
          window.scope.canvasChange({
            tabId,
            requestId,
            target: { board: true },
            base: await version(),
            label: "Test",
            ops: ops as never,
          });
        const card = (title: string, x = 1) => ({
          type: "boxes",
          title,
          x,
          y: 0,
          w: 200,
          h: 200,
          z: "a",
        });
        const made = await change([{ op: "put", id: "$a", value: card("A") }]);
        if (!made.ok) throw new Error(made.message);
        const cardId = made.refs.$a;
        // A board card's ID cannot also name a record inside a card.
        const reused = await window.scope.canvasChange({
          tabId,
          requestId: id(),
          target: { card: cardId },
          base: 0,
          label: "Reuse",
          ops: [{ op: "put", id: cardId, value: { type: "box" } }],
        });
        // One change that moves a card and then deletes it undoes to where it was before.
        const gone = await change([
          { op: "set", id: cardId, fields: { x: 2 } },
          { op: "del", id: cardId },
        ]);
        const undo = await window.scope.canvasStep({
          tabId,
          requestId: id(),
          target: { board: true },
          direction: "undo",
        });
        const restored = (await window.scope.canvasRead(tabId))!.board.cards[cardId];
        // A retry long after its undo step was trimmed returns the first answer.
        const first = id();
        const renamed = await change([{ op: "set", id: cardId, fields: { title: "B" } }], first);
        for (let index = 0; index < 501; index++)
          await change([{ op: "set", id: cardId, fields: { x: index } }]);
        const before = (await window.scope.canvasRead(tabId))!.board;
        const retried = await window.scope.canvasChange({
          tabId,
          requestId: first,
          target: { board: true },
          base: renamed.ok ? renamed.version - 1 : 0,
          label: "Test",
          ops: [{ op: "set", id: cardId, fields: { title: "B" } }],
        });
        const after = (await window.scope.canvasRead(tabId))!.board;
        return { reused, gone, undo, restored, renamed, retried, before, after };
      }, tabId);
      expect(outcome.reused).toMatchObject({ ok: false, code: "invalid" });
      expect(outcome.gone.ok).toBe(true);
      expect(outcome.undo).toMatchObject({ ok: true, kept: [] });
      expect(outcome.restored).toMatchObject({ title: "A", x: 1 });
      expect(outcome.retried).toEqual(outcome.renamed);
      expect(outcome.after).toEqual(outcome.before);
      const db = new DatabaseSync(join(f.settingsDirectory, "artifacts/scope.db"));
      try {
        const rows = db
          .prepare("SELECT count(*) AS n FROM canvas_history WHERE tab_id = ?")
          .get(tabId);
        expect(Number(rows?.n)).toBeLessThanOrEqual(500);
      } finally {
        db.close();
      }
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
