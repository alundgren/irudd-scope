import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import {
  board,
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

test(
  "a boxes card works like the prototype, one undo step per gesture",
  { tags: ["no-lost-updates"], timeout: 240_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Prototype");
      const [card] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
      ]);
      await openCard(page, "Order flow");
      const editor = pane(page);
      const content = () => cardContent(page, tabId, card);
      const history = () => cardHistory(f.settingsDirectory, tabId, card);
      const steps = async (count: number) => expect.poll(history).toBe(count);
      // Scroll so the diagram, including the section drawn above it, starts well inside the view.
      const surfaceBox = (await editor
        .getByLabel("Diagram canvas", { exact: true })
        .boundingBox())!;
      await page.mouse.move(surfaceBox.x + 400, surfaceBox.y + 300);
      await page.mouse.wheel(-60, -100);
      await expect
        .poll(async () => (await editorPoint(page, 0, 0)).y)
        .toBeGreaterThan(surfaceBox.y + 150);
      // No bars above the diagram: it fills the editor, with one small toolbar floating on it.
      const editorBox = (await editor.boundingBox())!;
      expect(surfaceBox.y).toBeCloseTo(editorBox.y, 0);
      expect(surfaceBox.height).toBeCloseTo(editorBox.height, 0);
      const toolbar = (await editor.getByLabel("Move card toolbar").boundingBox())!;
      expect(toolbar.x - surfaceBox.x).toBeCloseTo(12, 0);
      expect(toolbar.y - surfaceBox.y).toBeCloseTo(12, 0);
      expect(toolbar.height).toBeLessThan(60);
      const tools = editor.getByRole("toolbar", { name: "Card" });
      for (const name of ["Board", "Undo", "Redo", "Section", "Delete selected"])
        await tools.getByRole("button", { name, exact: true }).waitFor();
      expect(await tools.getByRole("heading", { name: "Order flow" }).count()).toBe(1);
      const surface = editor.getByLabel("Diagram canvas", { exact: true });
      expect(await surface.getAttribute("title")).toBe("Drag on the canvas to draw a box");
      // Space shows the pan cursor and Ctrl the zoom cursor, until they are let go.
      const cursor = () => surface.evaluate((element) => getComputedStyle(element).cursor);
      await surface.focus();
      await page.keyboard.down(" ");
      await expect.poll(cursor).toBe("grab");
      await page.keyboard.up(" ");
      await expect.poll(cursor).toBe("crosshair");
      await page.keyboard.down("Control");
      await expect.poll(cursor).toBe("zoom-in");
      await page.keyboard.up("Control");
      await expect.poll(cursor).toBe("crosshair");

      // Drag on empty space draws a box.
      const from = await editorPoint(page, 0, 0);
      await drag(page, from, 160, 80);
      await expect.poll(async () => records(await content(), "box").length).toBe(1);
      const [[web, box]] = records(await content(), "box");
      expect(box).toMatchObject({ x: 0, y: 0, w: 160, h: 80 });
      await steps(1);

      // Double-click types; Escape finishes.
      await page.mouse.dblclick(from.x + 80, from.y + 40);
      await editor.getByLabel("Box text", { exact: true }).fill("Web app");
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await content())[web].text).toBe("Web app");
      await steps(2);
      const node = (name: string) => editor.getByRole("button", { name, exact: true });

      // Dragging from an edge strip into empty space adds a connected box that starts typing.
      await node("Web app").click();
      const strip = await center(page, node("Web app").locator(".boxes-strip").nth(2));
      await page.mouse.move(strip.x, strip.y);
      await page.mouse.down();
      await page.mouse.move(strip.x + 150, strip.y + 20, { steps: 5 });
      await page.mouse.move(strip.x + 300, strip.y + 20, { steps: 5 });
      await editor.locator(".boxes-ghost").waitFor();
      await page.mouse.up();
      await expect
        .poll(() =>
          editor
            .getByLabel("Box text", { exact: true })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.type("Cache");
      await page.keyboard.press("ControlOrMeta+Enter");
      await steps(3);
      let now = await content();
      const [cache] = records(now, "box").find(([, record]) => record.text === "Cache")!;
      expect(now[cache]).toMatchObject({ x: 380, y: 0, w: 160, h: 80 });
      const [[toCache, link]] = records(now, "connector");
      expect(link).toMatchObject({ from: { id: web }, to: { id: cache } });

      // Clicking a strip and then another box connects them.
      await drag(page, await editorPoint(page, 0, 200), 160, 80);
      await steps(4);
      now = await content();
      const [db] = records(now, "box").find(([id]) => id !== web && id !== cache)!;
      await node("Web app").click();
      await node("Web app").locator(".boxes-strip").nth(4).click();
      await node("Box").click();
      await steps(5);
      now = await content();
      const [toDb] = records(now, "connector").find(([id]) => id !== toCache)!;
      expect(now[toDb]).toMatchObject({ from: { id: web }, to: { id: db } });

      // The box kind picker changes a box's kind while typing.
      await node("Box").dblclick();
      await editor.getByLabel("Box text", { exact: true }).fill("Orders DB");
      await editor.getByRole("button", { name: "Change kind", exact: true }).click();
      await editor.getByLabel("Find a box kind", { exact: true }).fill("data");
      await expect.poll(() => editor.getByRole("menuitemradio").count()).toBe(1);
      await editor.getByRole("menuitemradio", { name: "Database" }).click();
      await steps(6);
      expect((await content())[db]).toMatchObject({ kind: "database", text: "Orders DB" });

      // A connector takes a label, and each arrowhead turns on and off by itself.
      const middle = await editorPoint(page, 270, 25);
      await page.mouse.dblclick(middle.x, middle.y);
      await editor.getByLabel("Connector label", { exact: true }).fill("reads");
      await page.keyboard.press("Enter");
      await steps(7);
      await editor.getByRole("button", { name: "Arrow at start", exact: true }).click();
      await steps(8);
      await editor.getByRole("button", { name: "Arrow at end", exact: true }).click();
      await steps(9);
      expect((await content())[toCache]).toMatchObject({
        label: "reads",
        arrowStart: true,
        arrowEnd: false,
      });

      // A section is drawn separately, its title slides along the top, and moving it moves what is inside.
      await editor.getByRole("button", { name: "Section", exact: true }).click();
      await drag(page, await editorPoint(page, -40, -60), 640, 400);
      await steps(10);
      now = await content();
      const [[section]] = records(now, "section");
      expect(now[section]).toMatchObject({ x: -40, y: -60, w: 640, h: 400, text: "Section" });
      const title = editor.locator(".boxes-section-title");
      await drag(page, await center(page, title), 200, 0);
      await steps(11);
      expect((await content())[section].title).toBeGreaterThan(0.3);
      expect((await content())[section].title).toBeLessThan(0.5);
      await drag(page, await center(page, editor.locator(".boxes-section-bottom")), 40, 60);
      await steps(12);
      now = await content();
      expect(now[section]).toMatchObject({ x: 0, y: 0 });
      expect(now[web]).toMatchObject({ x: 40, y: 60 });
      expect(now[cache]).toMatchObject({ x: 420, y: 60 });
      expect(now[db]).toMatchObject({ x: 40, y: 260 });

      // Escape during a drag puts things back.
      const grab = await center(page, node("Cache"));
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x + 100, grab.y + 100, { steps: 5 });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      expect((await content())[cache]).toMatchObject({ x: 420, y: 60 });
      await editor.getByRole("heading", { name: "Order flow" }).waitFor();

      // Arrow keys nudge by one grid step.
      await node("Cache").click();
      await page.keyboard.press("ArrowRight");
      await steps(13);
      expect((await content())[cache]).toMatchObject({ x: 440, y: 60 });

      // Deleting a box takes its connectors along, and the bar offers Undo.
      await node("Orders DB").click();
      await page.keyboard.press("Delete");
      await editor.getByRole("status").filter({ hasText: "Deleted box and 1 connector" }).waitFor();
      await expect.poll(async () => (await content())[db]).toBeUndefined();
      expect((await content())[toDb]).toBeUndefined();
      await editor.getByRole("button", { name: "Undo", exact: true }).click();
      await expect.poll(async () => (await content())[db]?.text).toBe("Orders DB");
      expect((await content())[toDb]).toBeDefined();

      // A new connected box whose text was erased, kept as a plain box, still saves.
      const boxCount = records(await content(), "box").length;
      await node("Cache").click();
      await drag(page, await center(page, node("Cache").locator(".boxes-strip").nth(2)), 300, 0);
      await page.keyboard.type("x");
      await page.keyboard.press("Backspace");
      await editor.getByRole("button", { name: "Change kind" }).click();
      await editor.getByRole("menuitemradio", { name: "Box", exact: true }).click();
      await expect.poll(async () => records(await content(), "box").length).toBe(boxCount + 1);
      const plain = records(await content(), "box").find(([, record]) => !("text" in record));
      expect(plain?.[1]).not.toHaveProperty("kind");
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

/** Writes records into a card through the canvas bridge, the way the editor does. */
const row = (x: number, text: string, z: string) => ({
  type: "box",
  x,
  y: 0,
  w: 160,
  h: 80,
  text,
  z,
});

test(
  "card undo stays in its card, survives restarts, and a deleted card comes back with its history",
  { tags: ["survives-restart", "no-lost-updates"], timeout: 300_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Undo");
      const [order, payment] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
        { title: "Payment states", x: 720, y: 0, w: 480, h: 360 },
      ]);
      const refs = await seedContent(page, tabId, order, "Seed", [
        { op: "put", id: "$web", value: row(0, "Web app", "a1") },
        { op: "put", id: "$api", value: row(240, "API", "a2") },
        { op: "put", id: "$db", value: row(480, "Orders DB", "a3") },
      ]);
      const paid = await seedContent(page, tabId, payment, "Seed", [
        { op: "put", id: "$new", value: row(0, "New", "a1") },
        { op: "put", id: "$paid", value: row(240, "Paid", "a2") },
        { op: "put", id: "$done", value: row(480, "Done", "a3") },
      ]);
      await seedContent(page, tabId, payment, "Rename", [
        { op: "set", id: paid.$paid, fields: { text: "Settled" } },
      ]);
      const boardBefore = await board(page, tabId);
      const paymentBefore = await cardContent(page, tabId, payment);
      const orderBefore = await cardContent(page, tabId, order);

      // Add three boxes to the right and below, then check the picture still fits its frame.
      await openCard(page, "Order flow");
      const editor = pane(page);
      const node = (name: string) => editor.getByRole("button", { name, exact: true });
      await drag(page, await editorPoint(page, 720, 0), 160, 80);
      await drag(page, await editorPoint(page, 720, 400), 160, 80);
      await node("Web app").click();
      const strip = await center(page, node("Web app").locator(".boxes-strip").nth(4));
      await drag(page, strip, 0, 260);
      await page.keyboard.type("Cache");
      await page.keyboard.press("Escape");
      await expect
        .poll(async () => records(await cardContent(page, tabId, order), "box").length)
        .toBe(6);
      const withCache = await cardContent(page, tabId, order);
      const [cache] = records(withCache, "box").find(([, record]) => record.text === "Cache")!;
      expect(records(withCache, "connector")).toHaveLength(1);
      await drag(page, await center(page, node("Web app")), -40, 0);
      await expect.poll(async () => (await cardContent(page, tabId, order))[refs.$web].x).toBe(-40);

      await page.keyboard.press("Escape");
      const frame = pane(page).getByRole("group", { name: "Order flow", exact: true });
      await frame.locator(".boxes-picture").waitFor();
      expect(await board(page, tabId)).toEqual(boardBefore);
      const body = (await frame.locator(".canvas-card-body").boundingBox())!;
      const shapes = await frame.locator(".boxes-picture .boxes-outline").all();
      expect(shapes.length).toBeGreaterThanOrEqual(6);
      const boxes = await Promise.all(shapes.map(async (shape) => (await shape.boundingBox())!));
      const left = Math.min(...boxes.map((b) => b.x));
      const top = Math.min(...boxes.map((b) => b.y));
      const right = Math.max(...boxes.map((b) => b.x + b.width));
      const bottom = Math.max(...boxes.map((b) => b.y + b.height));
      expect(left).toBeGreaterThanOrEqual(body.x);
      expect(top).toBeGreaterThanOrEqual(body.y);
      expect(right).toBeLessThanOrEqual(body.x + body.width);
      expect(bottom).toBeLessThanOrEqual(body.y + body.height);
      // Scaled down and centered in the frame.
      expect(right - left).toBeLessThan(880);
      expect(Math.abs((left + right) / 2 - (body.x + body.width / 2))).toBeLessThan(4);
      expect(Math.abs((top + bottom) / 2 - (body.y + body.height / 2))).toBeLessThan(4);

      // Ctrl+Z first moves Web app back, then removes Cache and its connector together.
      await openCard(page, "Order flow");
      const surface = editor.getByLabel("Diagram canvas", { exact: true });
      await surface.focus();
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await cardContent(page, tabId, order))[refs.$web].x).toBe(0);
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await cardContent(page, tabId, order))[cache]).toBeUndefined();
      expect(records(await cardContent(page, tabId, order), "connector")).toHaveLength(0);
      expect(await board(page, tabId)).toEqual(boardBefore);
      expect(await cardContent(page, tabId, payment)).toEqual(paymentBefore);

      // After a restart the editor is open again, and redo brings both steps back in order.
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      await pane(page).getByLabel("Diagram canvas", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect
        .poll(async () => (await cardContent(page, tabId, order))[cache]?.text)
        .toBe("Cache");
      expect((await cardContent(page, tabId, order))[refs.$web].x).toBe(0);
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(async () => (await cardContent(page, tabId, order))[refs.$web].x).toBe(-40);
      expect(await cardContent(page, tabId, payment)).toEqual(paymentBefore);
      expect(Object.keys(orderBefore).every((id) => id in withCache)).toBe(true);

      // Delete Payment states, restart, and undo on the board brings it back with its history.
      await page.keyboard.press("Escape");
      await pane(page).getByRole("group", { name: "Payment states", exact: true }).click();
      await page.keyboard.press("Delete");
      await expect.poll(async () => (await board(page, tabId))[payment]).toBeUndefined();
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("group", { name: "Order flow", exact: true }).waitFor();
      await pane(page).getByLabel("Canvas board", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => (await board(page, tabId))[payment])
        .toEqual(boardBefore[payment]);
      expect(await cardContent(page, tabId, payment)).toEqual(paymentBefore);
      await openCard(page, "Payment states");
      await pane(page).getByLabel("Diagram canvas", { exact: true }).focus();
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(async () => (await cardContent(page, tabId, payment))[paid.$paid].text)
        .toBe("Paid");
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => cardContent(page, tabId, payment)).toEqual({});
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);

      // Text still being typed when Scope quits is kept, and the toolbar stays where it was left.
      await page.keyboard.press("Escape");
      await openCard(page, "Order flow");
      const area = (await pane(page).getByLabel("Diagram canvas", { exact: true }).boundingBox())!;
      const grip = await center(page, pane(page).locator(".canvas-card-grip"));
      await drag(page, grip, area.x + area.width - 20 - grip.x, area.y + area.height - 20 - grip.y);
      const toolbar = pane(page).getByLabel("Move card toolbar");
      const placed = (await toolbar.boundingBox())!;
      expect(Math.abs(placed.x + placed.width - area.x - area.width)).toBeLessThan(2);
      expect(Math.abs(placed.y + placed.height - area.y - area.height)).toBeLessThan(2);
      const saved = () => page.evaluate(() => window.scope.canvasToolbarPosition());
      await expect.poll(async () => (await saved())?.x ?? 0).toBeCloseTo(placed.x - area.x, 0);
      expect((await saved())?.y).toBeCloseTo(placed.y - area.y, 0);
      await pane(page).getByRole("button", { name: "API", exact: true }).dblclick();
      await pane(page).getByLabel("Box text", { exact: true }).fill("API gateway");
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await pane(page).getByRole("heading", { name: "Order flow", exact: true }).waitFor();
      expect((await cardContent(page, tabId, order))[refs.$api].text).toBe("API gateway");
      const back = (await pane(page).getByLabel("Move card toolbar").boundingBox())!;
      expect(back.x).toBeCloseTo(placed.x, 0);
      expect(back.y).toBeCloseTo(placed.y, 0);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "the board and the card editor offer fullscreen Edit, View and Present, and Escape steps back in order",
  { tags: ["tabs-stay-put"], timeout: 180_000 },
  async () => {
    const f = await desktopFixture({ hideInitialPrompts: true });
    const application = await f.launch();
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const tabId = await newCanvas(page, "Modes");
      const [card] = await seedCards(page, tabId, [
        { title: "Order flow", x: 0, y: 0, w: 640, h: 400 },
      ]);
      const refs = await seedContent(page, tabId, card, "Seed", [
        { op: "put", id: "$web", value: row(0, "Web app", "a1") },
      ]);
      const before = await board(page, tabId);
      const content = () => cardContent(page, tabId, card);

      await page.keyboard.press("ControlOrMeta+Shift+f");
      const mode = page.getByRole("combobox", { name: "Fullscreen canvas mode" });
      await expect.poll(() => mode.inputValue()).toBe("edit");
      const frame = pane(page).getByRole("group", { name: "Order flow", exact: true });
      for (const value of ["view", "present"]) {
        await mode.selectOption(value);
        await expect.poll(() => pane(page).getByRole("toolbar", { name: "Board" }).count()).toBe(0);
        await drag(page, await center(page, frame.locator(".canvas-card-title")), 120, 60);
        await page.waitForTimeout(300);
        expect(await board(page, tabId)).toEqual(before);
        // Zooming still works.
        await pane(page).getByRole("button", { name: "Zoom in", exact: true }).click();
      }
      await mode.selectOption("edit");

      // In the editor, View and Present allow looking around but no edits.
      await openCard(page, "Order flow");
      const editor = pane(page);
      for (const value of ["view", "present"]) {
        await mode.selectOption(value);
        await expect.poll(() => editor.getByRole("group", { name: "Diagram" }).count()).toBe(0);
        await drag(page, await editorPoint(page, 200, 200), 160, 80);
        await drag(
          page,
          await center(page, editor.getByRole("button", { name: "Web app" })),
          80,
          0,
        );
        const at = await center(page, editor.getByRole("button", { name: "Web app" }));
        await page.mouse.dblclick(at.x, at.y);
        await expect.poll(() => editor.getByLabel("Box text").count()).toBe(0);
        expect(Object.keys(await content())).toEqual([refs.$web]);
        expect((await content())[refs.$web]).toMatchObject({ x: 0, y: 0 });
      }
      await mode.selectOption("edit");

      // Switching to View while typing finishes the text, and the text field goes away.
      await editor.getByRole("button", { name: "Web app", exact: true }).dblclick();
      await editor.getByLabel("Box text", { exact: true }).fill("Web site");
      await mode.selectOption("view");
      await expect.poll(() => editor.getByLabel("Box text").count()).toBe(0);
      await expect.poll(async () => (await content())[refs.$web].text).toBe("Web site");
      await mode.selectOption("edit");

      // Escape: typing ends, then View goes back to Edit, then the editor closes, then fullscreen.
      const web = editor.getByRole("button", { name: "Web site", exact: true });
      await web.dblclick();
      await editor.getByLabel("Box text", { exact: true }).fill("Web");
      await page.keyboard.press("Escape");
      await expect.poll(() => editor.getByLabel("Box text").count()).toBe(0);
      await expect.poll(() => mode.inputValue()).toBe("edit");
      await editor.getByRole("heading", { name: "Order flow" }).waitFor();
      await expect.poll(async () => (await content())[refs.$web].text).toBe("Web");
      await mode.selectOption("view");
      await editor.getByLabel("Diagram canvas", { exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => mode.inputValue()).toBe("edit");
      await editor.getByRole("heading", { name: "Order flow" }).waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(() => editor.getByRole("heading", { name: "Order flow" }).count()).toBe(0);
      await pane(page).getByLabel("Canvas board", { exact: true }).waitFor();
      await mode.waitFor();
      await page.keyboard.press("Escape");
      await expect.poll(() => mode.count()).toBe(0);
      await page.getByRole("tab", { name: "Modes" }).waitFor();
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
