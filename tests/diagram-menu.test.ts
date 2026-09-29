import { expect, test } from "vite-plus/test";
import type { ElectronApplication } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";
import { diagramDelta, type NativeDiagram } from "@irudd-scope/protocol/diagram-sync";

async function menuEnabled(application: ElectronApplication, id: string) {
  return application.evaluate(
    ({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled,
    id,
  );
}

async function clickMenu(application: ElectronApplication, id: string) {
  await expect.poll(() => menuEnabled(application, id)).toBe(true);
  await application.evaluate(({ Menu, BrowserWindow }, id) => {
    const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
    item.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent);
  }, id);
}

test(
  "diagram menus fit the selected canvas and copy its latest edits with retry",
  { timeout: 60_000 },
  async () => {
    const fixture = await desktopFixture();
    const application = await fixture.launch();
    try {
      const page = await application.firstWindow();
      const client = await fixture.connect();
      await page.getByRole("button", { name: "Search and controls" }).waitFor();
      expect(await menuEnabled(application, "diagram-save-copy")).toBe(false);
      expect(await menuEnabled(application, "diagram-fit")).toBe(false);
      const original = nativeDiagram(3);
      await client.publish(
        "menu-diagram",
        {
          title: "Menu diagram",
          name: "menu-diagram",
          kind: "excalidraw",
          mediaType: "application/vnd.excalidraw+json",
          fileName: "menu.excalidraw",
          expectedRevision: 0,
        },
        Buffer.from(JSON.stringify(original)),
      );
      await page.getByRole("tab", { name: "Menu diagram", exact: true }).waitFor();
      await page.locator("canvas.interactive").waitFor();
      const tabId = (await page.getByRole("tab", { selected: true }).getAttribute("id"))!.slice(4);
      const readViewport = async () =>
        (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.viewport;
      await expect.poll(readViewport).toBeDefined();
      const fitted = await readViewport();
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      await page.mouse.move(600, 400);
      await page.mouse.wheel(1200, 1400);
      await expect.poll(readViewport).not.toEqual(fitted);
      await clickMenu(application, "diagram-fit");
      await expect.poll(readViewport).toEqual(fitted);

      await client.publish(
        "notes",
        {
          title: "Notes",
          kind: "text",
          mediaType: "text/plain",
          fileName: "notes.txt",
          expectedRevision: 0,
        },
        Buffer.from("A file tab has no diagram commands."),
      );
      await page.getByRole("tab", { name: "Notes", exact: true }).click();
      await expect.poll(() => menuEnabled(application, "diagram-fit")).toBe(false);
      expect(await menuEnabled(application, "diagram-save-copy")).toBe(false);
      await page.getByRole("tab", { name: "Menu diagram", exact: true }).click();
      await expect.poll(readViewport).toEqual(fitted);

      for (const appearance of ["light", "dark"] as const) {
        await page.keyboard.press("ControlOrMeta+,");
        await page.getByLabel("Search settings").fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.setViewportSize(
          appearance === "light" ? { width: 1280, height: 820 } : { width: 700, height: 620 },
        );
        await page.getByTestId("main-menu-trigger").click();
        expect(
          await page.getByRole("button", { name: "Save a copy", exact: true }).isVisible(),
        ).toBe(true);
        const fit = page.getByRole("button", { name: "Fit to canvas", exact: true });
        await fit.focus();
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(process.env.SCOPE_TEST_SCREENSHOTS, `diagram-actions-${appearance}.png`),
            animations: "disabled",
          });
        }
        await page.keyboard.press("Enter");
        await fit.waitFor({ state: "hidden" });
      }

      // Keep an unpublished edit in the original and fail the first copy independently.
      await application.evaluate(({ ipcMain }) => {
        type Handler = Parameters<typeof ipcMain.handle>[1];
        const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
          ._invokeHandlers;
        const original = handlers.get("scope:save-diagram")!;
        let failCopy = true;
        Object.assign(globalThis, {
          restoreDiagramSave: () => {
            ipcMain.removeHandler("scope:save-diagram");
            ipcMain.handle("scope:save-diagram", original);
          },
        });
        ipcMain.removeHandler("scope:save-diagram");
        ipcMain.handle("scope:save-diagram", (event, input) => {
          if (input.id === "menu-diagram") throw new Error("Original save is unavailable.");
          if (failCopy) {
            failCopy = false;
            throw new Error("Copy save is unavailable.");
          }
          return original(event, input);
        });
      });
      await page.getByTestId("toolbar-text").locator("..").click();
      await page.locator("canvas.interactive").click({ position: { x: 350, y: 350 } });
      await page.locator("textarea.excalidraw-wysiwyg").fill("Latest unpublished note");
      await page.keyboard.press("Escape");
      await page.getByText("Could not save this diagram. Keep Scope open and retry.").waitFor();
      await clickMenu(application, "diagram-save-copy");
      await page.getByText("Copy save is unavailable.", { exact: false }).waitFor();
      expect((await client.list()).length).toBe(2);
      await clickMenu(application, "diagram-save-copy");
      await expect.poll(async () => (await client.list()).length).toBe(3);
      const copy = (await client.list()).find((item) => item.title === "Menu diagram copy")!;
      expect(copy.id).not.toBe("menu-diagram");
      expect(copy.name).toBeUndefined();
      const content = JSON.parse(new TextDecoder().decode(await client.content(copy.id)));
      expect(
        content.elements.some(
          (element: { text?: string }) => element.text === "Latest unpublished note",
        ),
      ).toBe(true);
      expect(await page.getByRole("tab", { selected: true }).textContent()).toContain(
        "Menu diagram",
      );
      expect((await client.get("menu-diagram")).revision).toBe(1);
      expect((await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.dirty).toBe(true);
    } finally {
      await application.evaluate(() =>
        (
          globalThis as typeof globalThis & { restoreDiagramSave?: () => void }
        ).restoreDiagramSave?.(),
      );
      await application.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test("first agent content fits an empty diagram and native actions target its visible proposal", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const client = await fixture.connect();
    await client.publish(
      "built-later",
      {
        title: "Built later",
        name: "built-later",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "built-later.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(nativeDiagram(0))),
    );
    await page.locator("canvas.interactive").waitFor();
    const tabId = (await page.getByRole("tab", { selected: true }).getAttribute("id"))!.slice(4);
    const draft = () => page.evaluate((id) => window.scope.diagramDraft(id), tabId);
    await expect.poll(async () => (await draft())?.viewport).toBeDefined();
    await clickMenu(application, "diagram-fit");
    expect((await draft())?.viewport?.zoom).toBe(1);
    const status = await client.syncDiagram({ action: "status", name: "built-later" });
    const original: NativeDiagram = {
      ...nativeDiagram(3),
      elements: nativeDiagram(3).elements.map((element) => ({
        ...element,
        x: Number(element.x) + 5000,
        y: Number(element.y) - 2000,
      })),
    };
    await client.syncDiagram({
      action: "replace",
      name: "built-later",
      expectedVersion: status.version,
      document: original,
    });
    await expect.poll(async () => (await draft())?.viewport?.scrollX).toBeLessThan(-4000);
    expect((await draft())?.viewport?.zoom).toBeGreaterThan(0.5);
    await page.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.poll(async () => (await draft())?.viewport?.zoom).toBeLessThan(1);
    const originalViewport = (await draft())!.viewport;
    const current = await client.syncDiagram({ action: "read", name: "built-later" });
    if (current.type !== "full") throw new Error("Expected a full diagram.");
    const proposed: NativeDiagram = {
      ...current.document,
      elements: current.document.elements.map((element) => ({
        ...element,
        x: Number(element.x) + 4000,
      })),
    };
    await client.syncDiagram({
      action: "propose",
      name: "built-later",
      expectedVersion: current.version,
      delta: diagramDelta(current.document, proposed),
      note: "Move the entire drawing.",
    });
    const preview = page.getByRole("region", { name: "Proposed diagram" });
    await preview.locator("canvas.interactive").waitFor();
    await expect.poll(async () => (await draft())?.proposalViewport?.scrollX).toBeLessThan(-8000);
    await preview.getByRole("button", { name: "Zoom out", exact: true }).click();
    await expect.poll(async () => (await draft())?.proposalViewport?.zoom).toBeLessThan(1);
    await clickMenu(application, "diagram-fit");
    await expect.poll(async () => (await draft())?.proposalViewport?.zoom).toBe(1);
    await clickMenu(application, "diagram-save-copy");
    await expect.poll(async () => (await client.list()).length).toBe(2);
    const copy = (await client.list()).find((artifact) => artifact.id !== "built-later")!;
    const copied = JSON.parse(new TextDecoder().decode(await client.content(copy.id)));
    expect(copied.elements[0].x).toBe(9000);
    expect(
      JSON.parse(new TextDecoder().decode(await client.content("built-later"))).elements[0].x,
    ).toBe(5000);
    expect((await draft())?.viewport).toEqual(originalViewport);
    expect(await preview.isVisible()).toBe(true);
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
