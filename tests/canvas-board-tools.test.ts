import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import {
  board,
  center,
  drag,
  historyCount,
  newCanvas,
  seedCards,
  settledCamera,
  camera,
  changedCamera,
  pane,
  type Camera,
} from "./canvas-fixture.ts";

const boardPoint = (camera: Camera, screen: { x: number; y: number }) => ({
  x: camera.x + screen.x / camera.zoom,
  y: camera.y + screen.y / camera.zoom,
});

test(
  "the board pans and zooms like a design tool, fits every card, and keeps its camera",
  { tags: ["survives-restart", "tabs-stay-put"], timeout: 180_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Big board");
      await seedCards(
        page,
        tabId,
        Array.from({ length: 8 }, (_, index) => ({
          title: `Card ${index + 1}`,
          x: (index % 4) * 1500,
          y: Math.floor(index / 4) * 3200,
          w: 600,
          h: 800,
        })),
      );
      const history = historyCount(f.settingsDirectory, tabId);
      const surface = page.getByLabel("Canvas board", { exact: true });
      const box = (await surface.boundingBox())!;

      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await expect.poll(async () => (await camera(page, tabId))?.zoom ?? 1).toBeLessThan(1);
      await settledCamera(page, tabId);
      for (const card of await page.locator(".canvas-card").all()) {
        const frame = (await card.boundingBox())!;
        expect(frame.x).toBeGreaterThanOrEqual(box.x);
        expect(frame.y).toBeGreaterThanOrEqual(box.y);
        expect(frame.x + frame.width).toBeLessThanOrEqual(box.x + box.width);
        expect(frame.y + frame.height).toBeLessThanOrEqual(box.y + box.height);
      }

      // Pinch and Ctrl+scroll zoom around the pointer.
      const pointer = { x: 300, y: 200 };
      let before = await settledCamera(page, tabId);
      await page.mouse.move(box.x + pointer.x, box.y + pointer.y);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -120);
      await page.keyboard.up("Control");
      let after = await changedCamera(page, tabId, before);
      expect(after.zoom).toBeGreaterThan(before.zoom);
      expect(boardPoint(after, pointer).x).toBeCloseTo(boardPoint(before, pointer).x, 3);
      expect(boardPoint(after, pointer).y).toBeCloseTo(boardPoint(before, pointer).y, 3);

      // Two-finger scrolling pans both ways; Shift with a mouse wheel pans sideways.
      before = after;
      await page.mouse.wheel(60, 90);
      after = await changedCamera(page, tabId, before);
      expect(after.x).toBeCloseTo(before.x + 60 / before.zoom, 3);
      expect(after.y).toBeCloseTo(before.y + 90 / before.zoom, 3);
      before = after;
      await page.keyboard.down("Shift");
      await page.mouse.wheel(0, 100);
      await page.keyboard.up("Shift");
      after = await changedCamera(page, tabId, before);
      expect(after.x).not.toBe(before.x);
      expect(after.y).toBe(before.y);

      // Space+drag and middle-button drag pan.
      before = after;
      await surface.focus();
      await page.keyboard.down(" ");
      await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, -120, -80);
      await page.keyboard.up(" ");
      after = await changedCamera(page, tabId, before);
      expect(after.x).toBeCloseTo(before.x + 120 / before.zoom, 1);
      expect(after.y).toBeCloseTo(before.y + 80 / before.zoom, 1);
      before = after;
      await page.mouse.move(box.x + 40, box.y + box.height - 120);
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(box.x + 100, box.y + box.height - 100, { steps: 4 });
      await page.mouse.up({ button: "middle" });
      after = await changedCamera(page, tabId, before);
      expect(after.x).toBeCloseTo(before.x - 60 / before.zoom, 1);

      // Ctrl+plus and minus, and the bottom bar, zoom around the view's center.
      const middle = { x: box.width / 2, y: box.height / 2 };
      for (const action of [
        () => page.keyboard.press("ControlOrMeta+="),
        () => page.keyboard.press("ControlOrMeta+-"),
        () => page.getByRole("button", { name: "Zoom in", exact: true }).click(),
        () => page.getByRole("button", { name: "Zoom out", exact: true }).click(),
      ]) {
        before = after;
        await surface.focus();
        await action();
        after = await changedCamera(page, tabId, before);
        expect(after.zoom).not.toBe(before.zoom);
        expect(boardPoint(after, middle).x).toBeCloseTo(boardPoint(before, middle).x, 3);
      }

      // There are no Shift+number shortcuts.
      before = after;
      for (const key of ["Shift+1", "Shift+2", "Shift+0"]) await page.keyboard.press(key);
      await page.waitForTimeout(1500);
      expect(await settledCamera(page, tabId)).toEqual(before);

      // Zoom stops at 5%.
      const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
      while (await zoomOut.isEnabled()) await zoomOut.click();
      after = await changedCamera(page, tabId, before);
      expect(after.zoom).toBeCloseTo(0.05, 5);
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      const saved = await changedCamera(page, tabId, after);
      expect(historyCount(f.settingsDirectory, tabId)).toBe(history);

      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("tab", { name: "Big board", selected: true }).waitFor();
      await page.getByRole("group", { name: "Card 8", exact: true }).waitFor();
      expect(await settledCamera(page, tabId)).toEqual(saved);
      expect(await page.getByLabel("Zoom level").textContent()).toBe(
        `${Math.round(saved.zoom * 100)}%`,
      );
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "cards snap to each other with guide lines, and Arrange tidies the board in one undo step",
  { tags: ["no-lost-updates"], timeout: 180_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Snapping");
      const [, payment] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
        { title: "Payment states", x: 720, y: 13, w: 480, h: 360 },
      ]);
      const title = page
        .getByRole("group", { name: "Payment states", exact: true })
        .locator(".canvas-card-title");
      const guides = () => page.locator("[data-guide]").count();
      const at = async () => (await board(page, tabId))[payment];

      // 4 px from lining up snaps and shows a guide line; 9 px does not.
      let history = historyCount(f.settingsDirectory, tabId);
      let shown = 0;
      await drag(page, await center(page, title), 0, -9, async () => {
        shown = await guides();
      });
      await expect.poll(async () => (await at()).y).toBe(0);
      expect(shown).toBeGreaterThan(0);
      expect(await guides()).toBe(0);
      expect(historyCount(f.settingsDirectory, tabId)).toBe(history + 1);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await at()).y).toBe(13);
      await drag(page, await center(page, title), 0, -4);
      await expect.poll(async () => (await at()).y).toBe(9);

      // Ctrl or Command moves freely.
      await page.keyboard.down("ControlOrMeta");
      await drag(page, await center(page, title), 0, -5);
      await page.keyboard.up("ControlOrMeta");
      await expect.poll(async () => (await at()).y).toBe(4);

      // Resizing snaps the dragged corner's edges too.
      await drag(page, await center(page, title), 0, -4);
      await expect.poll(async () => (await at()).y).toBe(0);
      history = historyCount(f.settingsDirectory, tabId);
      const corner = page
        .getByRole("group", { name: "Payment states", exact: true })
        .locator(".canvas-card-resize");
      await drag(page, await center(page, corner), 0, 36);
      await expect.poll(async () => (await at()).h).toBe(400);
      expect(historyCount(f.settingsDirectory, tabId)).toBe(history + 1);

      // Arrange: five cards, two overlapping, in reading order with 40-unit gaps.
      const tab = await newCanvas(page, "Messy");
      await seedCards(page, tab, [
        { title: "A", x: 500, y: 40, w: 300, h: 200 },
        { title: "B", x: 560, y: 120, w: 200, h: 400 },
        { title: "C", x: -900, y: 900, w: 500, h: 300 },
        { title: "D", x: 1600, y: -300, w: 260, h: 260 },
        { title: "E", x: 100, y: 700, w: 420, h: 180 },
      ]);
      const start = await board(page, tab);
      await pane(page).getByRole("button", { name: "Arrange", exact: true }).click();
      await expect
        .poll(async () => JSON.stringify(await board(page, tab)))
        .not.toBe(JSON.stringify(start));
      const arranged = Object.values(await board(page, tab));
      const byTitle = Object.fromEntries(arranged.map((card) => [card.title, card]));
      for (const card of arranged) {
        expect(card.w).toBe(Object.values(start).find((s) => s.title === card.title)!.w);
        for (const other of arranged)
          if (other !== card)
            expect(
              card.x + card.w <= other.x ||
                other.x + other.w <= card.x ||
                card.y + card.h <= other.y ||
                other.y + other.h <= card.y,
            ).toBe(true);
      }
      // Reading order: D (top), A, B, E, C.
      expect(byTitle.A.x).toBe(byTitle.D.x + byTitle.D.w + 40);
      expect(byTitle.B.x).toBe(byTitle.A.x + byTitle.A.w + 40);
      const rows = [...new Set(arranged.map((card) => card.y))].toSorted((a, b) => a - b);
      expect(rows.length).toBeGreaterThan(1);
      const first = arranged.filter((card) => card.y === rows[0]);
      expect(rows[1]).toBe(rows[0] + Math.max(...first.map((card) => card.h)) + 40);
      await pane(page).getByLabel("Canvas board", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(() => board(page, tab)).toEqual(start);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
