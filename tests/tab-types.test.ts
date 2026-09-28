import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";

const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAACUUlEQVR4nO3SQQ3CAABFsRkHL+OIBA6I4DozuOAnvCaV0OP2/KSc70fK9bqnHPNhQgsttNBCCy10gNB/bj5MaKGFFlpooYUumA8TWmihhRZaaKEL5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUWumA+TGihhRZaaKGFLpgPE1pooYUWWmihC+bDhBZaaKGFFlrogvkwoYUWWmihhRa6YD5MaKGFFlpooYUumA8TWmihhRZaaKEL5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUWumA+TGihhRZaaKGFLpgPE1pooYUWWmihC+bDhBZaaKGFFlrogvkwoYUWWmihhRa6YD5MaKGFFlpooYUumA8TWmihhRZaaKEL5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUWumA+TGihhRZaaKGFLpgPE1pooYUWWmihC+bDhBZaaKGFFlrogvkwoYUWWmihhRa6YD5MaKGFFlpooYUumA8TWmihhRZaaKEL5sOEFlpooYUWWuiC+TChhRZaaKGFFrpgPkxooYUWWmihhS6YDxNaaKGFFlpooQvmw4QWWmihhRZa6IL5MKGFFlpooYUWumA+TGihhRZaaKGFLpgP+7Ev79vIOQnL0Y8AAAAASUVORK5CYII=",
  "base64",
);
const examples = [
  {
    id: "notes",
    title: "Markdown notes",
    kind: "markdown",
    mediaType: "text/markdown",
    fileName: "notes.md",
    content: "# Markdown review\n\nA **formatted** note with a [link](https://example.invalid).",
  },
  {
    id: "log",
    title: "Plain text",
    kind: "text",
    mediaType: "text/plain",
    fileName: "log.txt",
    content: "Build completed.\n<script>This stays literal.</script>",
  },
  {
    id: "preview",
    title: "HTML preview",
    kind: "html",
    mediaType: "text/html",
    fileName: "preview.html",
    content:
      "<h1>HTML review</h1><p>A styled preview.</p><script>document.body.dataset.executed='yes'</script>",
  },
  {
    id: "picture",
    title: "Sample image",
    kind: "image",
    mediaType: "image/png",
    fileName: "picture.png",
    content: imageBytes,
  },
  {
    id: "download",
    title: "Binary file",
    kind: "file",
    mediaType: "application/octet-stream",
    fileName: "sample.bin",
    content: new Uint8Array([0, 1, 2, 3]),
  },
  {
    id: "drawing",
    title: "Editable diagram",
    kind: "excalidraw",
    mediaType: "application/vnd.excalidraw+json",
    fileName: "drawing.excalidraw",
    content: JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 100,
          y: 100,
          width: 240,
          height: 120,
          angle: 0,
          strokeColor: "#1e1e1e",
          backgroundColor: "#a5d8ff",
          fillStyle: "solid",
          strokeWidth: 2,
          strokeStyle: "solid",
          roughness: 0,
          opacity: 100,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link: null,
          locked: false,
        },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  },
];

async function checkContent(page: Page, example: (typeof examples)[number], focused = false) {
  const pane = page.getByRole("tabpanel", { name: example.title, exact: true });
  await pane.waitFor();
  switch (example.kind) {
    case "markdown":
      await pane.getByRole("heading", { name: "Markdown review" }).waitFor();
      expect(await pane.getByRole("link").count()).toBe(0);
      break;
    case "text":
      expect(await pane.locator("pre").textContent()).toContain(
        "<script>This stays literal.</script>",
      );
      break;
    case "html": {
      const frame = pane.frameLocator("iframe");
      await frame.getByRole("heading", { name: "HTML review" }).waitFor();
      expect(await frame.locator("body").getAttribute("data-executed")).toBe("yes");
      break;
    }
    case "image":
      await expect
        .poll(() =>
          pane.getByRole("img").evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBe(240);
      break;
    case "file":
      await pane.getByRole("heading", { name: "sample.bin" }).waitFor();
      await pane.getByText("Use Download to save this file.").waitFor();
      break;
    case "excalidraw":
      await pane.locator(".excalidraw canvas").first().waitFor();
      if (!focused) await pane.getByTestId("main-menu-trigger").waitFor();
      expect(await pane.getByRole("button", { name: "Save", exact: true }).count()).toBe(0);
      expect(await pane.getByRole("button", { name: "Ask agent", exact: true }).count()).toBe(0);
      expect(await pane.getByRole("complementary", { name: "Diagram agent" }).isVisible()).toBe(
        false,
      );
      break;
  }
}

test("the built CLI publishes every tab view through appearance, focus, restart, trash, and explicit deletion", async () => {
  const { directory, launch, cli, connect } = await desktopFixture();
  let application = await launch();
  const failures: string[] = [];
  const fullscreen = () =>
    application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
  try {
    let page = await application.firstWindow();
    if (process.platform !== "darwin") {
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isMenuBarVisible(),
        ),
      ).toBe(false);
    }
    page.on("pageerror", (error) => failures.push(error.message));
    for (const example of examples) {
      const file = join(directory, example.fileName);
      await writeFile(file, example.content);
      const receipt = await cli("add", file, "--id", example.id, "--title", example.title);
      expect(JSON.parse(receipt.stdout)).toMatchObject({
        id: example.id,
        kind: example.kind,
        mediaType: example.mediaType,
        revision: 1,
      });
    }
    for (const appearance of ["light", "dark"] as const) {
      await page.getByRole("button", { name: "Search and controls", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Search and controls", exact: true })
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 700, height: 620 },
      );
      for (const example of examples) {
        await page.getByRole("button", { name: "Search and controls" }).click();
        await page.getByLabel("Search artifacts", { exact: true }).fill(example.title);
        await page
          .getByRole("button", { name: `${example.title} ${example.kind}`, exact: true })
          .click();
        await checkContent(page, example);
        if (example.kind === "file" && appearance === "light") {
          const destination = join(directory, "downloaded.bin");
          await application.evaluate(({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath });
          }, destination);
          await page.getByRole("button", { name: "Search and controls", exact: true }).click();
          await page.getByRole("button", { name: "Download", exact: true }).click();
          await expect.poll(async () => [...(await readFile(destination))]).toEqual([0, 1, 2, 3]);
        }
        const pane = await page
          .getByRole("tabpanel", { name: example.title, exact: true })
          .elementHandle();
        await page.getByRole("button", { name: "Search and controls" }).click();
        await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
        await checkContent(page, example, true);
        await expect.poll(fullscreen).toBe(true);
        if (example.kind === "excalidraw") {
          const mode = page.getByRole("combobox", { name: "Fullscreen diagram mode" });
          const bounds = await mode.boundingBox();
          const width = await page.evaluate(() => innerWidth);
          expect(bounds!.width).toBeLessThanOrEqual(150);
          expect(bounds!.height).toBeLessThanOrEqual(32);
          expect(width - bounds!.x - bounds!.width).toBeLessThanOrEqual(12);
          expect(bounds!.y).toBeLessThanOrEqual(12);
          expect(await mode.inputValue()).toBe("edit");
          await page.getByTestId("main-menu-trigger").waitFor();
          await page
            .getByRole("dialog", { name: "Search and controls" })
            .waitFor({ state: "hidden" });
          await page
            .locator(".excalidraw canvas.interactive")
            .click({ position: { x: 300, y: 250 } });
          await page.keyboard.press("Shift+1");
          if (process.env.SCOPE_TEST_SCREENSHOTS) {
            await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-diagram-edit.png`),
            });
          }
          await mode.selectOption("view");
          expect(await page.locator(".excalidraw .layer-ui__wrapper").isVisible()).toBe(false);
          expect(await page.locator(".excalidraw .App-bottom-bar").isVisible()).toBe(false);
          expect(
            await page.getByRole("button", { name: "Ask agent", exact: true }).isVisible(),
          ).toBe(false);
          const tabId = (await page
            .getByRole("tabpanel", { name: example.title })
            .getAttribute("id"))!.slice(5);
          await expect
            .poll(
              async () =>
                (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.viewport,
            )
            .toBeDefined();
          const initialViewport = (await page.evaluate(
            (id) => window.scope.diagramDraft(id),
            tabId,
          ))!.viewport;
          await page.mouse.move(400, 300);
          await page.mouse.wheel(100, 140);
          await expect
            .poll(() => page.evaluate((id) => window.scope.diagramDraft(id), tabId))
            .not.toMatchObject({ viewport: initialViewport });
          const pannedZoom = (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))!
            .viewport.zoom;
          await page.keyboard.down("Control");
          await page.mouse.wheel(0, -200);
          await page.keyboard.up("Control");
          await expect
            .poll(
              async () =>
                (await page.evaluate((id) => window.scope.diagramDraft(id), tabId))?.viewport.zoom,
            )
            .not.toBe(pannedZoom);
          if (process.env.SCOPE_TEST_SCREENSHOTS) {
            await page.screenshot({
              path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-diagram-view.png`),
            });
          }
          await mode.selectOption("present");
          await page.mouse.move(250, 250);
          await expect
            .poll(() =>
              page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
            )
            .toBe("1");
          if (process.env.SCOPE_TEST_SCREENSHOTS) {
            await page.screenshot({
              path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-diagram-present.png`),
            });
          }
          await page.keyboard.press("Escape");
          expect(await mode.inputValue()).toBe("edit");
          await mode.selectOption("tabs");
        } else {
          await page.getByRole("button", { name: "Exit focus mode" }).click();
        }
        await expect.poll(fullscreen).toBe(false);
        expect(await pane!.evaluate((element) => element.isConnected)).toBe(true);
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-${example.kind}.png`),
          });
        }
      }
    }
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect.poll(fullscreen).toBe(true);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setFullScreen(false);
    });
    await page.getByRole("navigation", { name: "Open artifacts" }).waitFor();
    expect(await page.getByRole("button", { name: "Exit focus mode" }).count()).toBe(0);
    expect(
      await page
        .getByRole("tab")
        .evaluateAll((tabs) => new Set(tabs.map((tab) => tab.getBoundingClientRect().y)).size),
    ).toBe(1);
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(examples.length);
    const visibleIds = await page
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.id.slice(4)));
    expect(
      (await page.evaluate(() => window.scope.workspace()))?.tabs.map((tab) => tab.id),
    ).toEqual(expect.arrayContaining(visibleIds));
    const before = await page.evaluate(() => window.scope.workspace());
    expect(before?.tabs.every((tab) => tab.id !== tab.state.data.artifactId)).toBe(true);
    expect(before?.tabs.find((tab) => tab.state.data.artifactId === "drawing")?.type).toBe(
      "diagram",
    );
    const accepted = await page.evaluate(async () => {
      const tab = (await window.scope.workspace())!.tabs[0];
      const event = {
        type: "resource.selected" as const,
        resource: { kind: "artifact", id: "notes" },
      };
      await window.scope.publishTabEvent({ tabId: tab.id, groupId: tab.groupId, event });
      try {
        await window.scope.publishTabEvent({ tabId: tab.id, groupId: crypto.randomUUID(), event });
        return false;
      } catch {
        return true;
      }
    });
    expect(accepted).toBe(true);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    page.on("pageerror", (error) => failures.push(error.message));
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(examples.length);
    expect(
      (await page.evaluate(() => window.scope.workspace()))?.tabs.map((tab) => tab.id),
    ).toEqual(before?.tabs.map((tab) => tab.id));
    for (const example of examples) {
      await page.getByRole("button", { name: "Search and controls" }).click();
      await page.getByLabel("Search artifacts", { exact: true }).fill(example.title);
      await page.keyboard.press("Enter");
      await checkContent(page, example);
    }
    const client = await connect();
    for (const [index, example] of examples.entries()) {
      const tab = page.getByRole("tab", { name: example.title, exact: true });
      await page.getByRole("button", { name: "Search and controls" }).click();
      await page.getByLabel("Search artifacts", { exact: true }).fill(example.title);
      await page.keyboard.press("Enter");
      await tab.waitFor();
      const id = (await tab.getAttribute("id"))!.slice(4);
      await page.keyboard.press("ControlOrMeta+w");
      await expect
        .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
        .toBe(examples.length - index - 1);
      expect(await client.get(example.id)).toBeDefined();
      await client.delete(example.id);
      expect(await page.evaluate((tabId) => window.scope.diagramDraft(tabId), id)).toBeNull();
    }
    expect(await client.list()).toEqual([]);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(0);
    expect(failures).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
