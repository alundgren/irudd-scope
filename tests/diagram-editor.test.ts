import { expect, test } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

async function addText(page: Page, text: string, y: number) {
  await page.locator(".excalidraw canvas.interactive").click({ position: { x: 500, y: 200 } });
  await page.keyboard.press("t");
  await page.mouse.click(400, y);
  await page.locator("textarea.excalidraw-wysiwyg").fill(text);
  await page.keyboard.press("Escape");
}

async function holdSave(application: ElectronApplication, phase: "before" | "after") {
  await application.evaluate(({ ipcMain }, phase) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers.get("scope:save-diagram")!;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const state = { started: false, release };
    Object.assign(globalThis, { diagramSaveGate: state });
    ipcMain.removeHandler("scope:save-diagram");
    ipcMain.handle("scope:save-diagram", async (event, input) => {
      ipcMain.removeHandler("scope:save-diagram");
      ipcMain.handle("scope:save-diagram", original);
      const result = phase === "after" ? await original(event, input) : undefined;
      state.started = true;
      await gate;
      return phase === "after" ? result : original(event, input);
    });
  }, phase);
  return {
    started: () =>
      application.evaluate(
        () =>
          (globalThis as typeof globalThis & { diagramSaveGate: { started: boolean } })
            .diagramSaveGate.started,
      ),
    release: () =>
      application.evaluate(() =>
        (
          globalThis as typeof globalThis & { diagramSaveGate: { release: () => void } }
        ).diagramSaveGate.release(),
      ),
  };
}

test.for(["before", "after"] as const)(
  "diagram autosave preserves further edits and immediate quit while a save waits %s publication",
  { timeout: 60_000 },
  async (phase) => {
    const f = await desktopFixture();
    let application = await f.launch();
    let gate: Awaited<ReturnType<typeof holdSave>> | undefined;
    try {
      let page = await application.firstWindow();
      page.setDefaultTimeout(5000);
      let client = await f.connect();
      await client.publish(
        "autosaved-diagram",
        {
          title: "Autosaved diagram",
          kind: "excalidraw",
          mediaType: "application/vnd.excalidraw+json",
          fileName: "autosaved-diagram.excalidraw",
          expectedRevision: 0,
        },
        Buffer.from(
          JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }),
        ),
      );
      await page.locator(".excalidraw canvas").first().waitFor();
      const tabId = (await page.getByRole("tab", { selected: true }).getAttribute("id"))!.slice(4);
      await expect
        .poll(() => page.evaluate((id) => window.scope.diagramDraft(id), tabId))
        .not.toBeNull();
      gate = await holdSave(application, phase);
      await addText(page, "First edit", 300);
      await expect.poll(gate.started).toBe(true);
      await addText(page, "Latest edit", 450);
      await gate.release();
      gate = undefined;
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(5000);
      client = await f.connect();
      await page.locator(".excalidraw canvas").first().waitFor();
      const savedRevision = (await client.get("autosaved-diagram")).revision;
      const content = JSON.parse(
        new TextDecoder().decode(await client.content("autosaved-diagram")),
      );
      expect(
        content.elements
          .filter((element: { type: string }) => element.type === "text")
          .map((element: { text: string }) => element.text),
      ).toEqual(["First edit", "Latest edit"]);
      await expect
        .poll(
          async () => (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.dirty,
        )
        .toBe(false);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
      expect(await page.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      expect(await page.locator(".excalidraw .help-icon").isVisible()).toBe(false);
      expect(await page.locator(".excalidraw .default-sidebar-trigger").isVisible()).toBe(false);

      await page.getByTestId("main-menu-trigger").click();
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await page.locator(".default-sidebar").waitFor();
      await page.locator(".sidebar__close").click();
      await page.getByTestId("main-menu-trigger").click();
      await page.getByTestId("search-menu-button").click();
      const search = page.locator(".default-sidebar input");
      await search.fill("Latest edit");
      await page.locator(".default-sidebar").getByText("Latest edit", { exact: true }).waitFor();
      await page.locator(".sidebar__close").click();
      await page.getByTestId("main-menu-trigger").click();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("button", { name: "Export to PNG", exact: true }).waitFor();
      await page.getByRole("button", { name: "Export to SVG", exact: true }).waitFor();
      const destination = join(f.directory, "export.png");
      await page.exposeFunction("writeDiagramExport", (bytes: number[]) =>
        writeFile(destination, new Uint8Array(bytes)),
      );
      // Choose a synthetic destination in place of the native file picker.
      await page.evaluate(() => {
        Object.assign(window, {
          showSaveFilePicker: async () => ({
            name: "export.png",
            createWritable: async () => ({
              write: async (blob: Blob) => {
                await (
                  window as typeof window & {
                    writeDiagramExport: (bytes: number[]) => Promise<void>;
                  }
                ).writeDiagramExport([...new Uint8Array(await blob.arrayBuffer())]);
              },
              close: async () => {},
            }),
          }),
        });
      });
      await page.getByRole("button", { name: "Export to PNG", exact: true }).click();
      await expect
        .poll(async () => (await readFile(destination)).subarray(0, 8).toString("hex"))
        .toBe("89504e470d0a1a0a");
      await page.getByRole("button", { name: "Export to SVG", exact: true }).focus();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      for (const appearance of ["light", "dark"]) {
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
        expect(await page.getByRole("button", { name: "Export", exact: true }).isVisible()).toBe(
          true,
        );
        expect(await page.getByRole("button", { name: "Library", exact: true }).isVisible()).toBe(
          true,
        );
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.SCOPE_TEST_SCREENSHOTS,
              `diagram-menu-${appearance}-${phase}.png`,
            ),
            animations: "disabled",
          });
        }
        await page.getByTestId("main-menu-trigger").click();
      }
      expect((await client.get("autosaved-diagram")).revision).toBe(savedRevision);
    } finally {
      await gate?.release().catch(() => {});
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
