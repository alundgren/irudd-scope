import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
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
      expect(await frame.locator("body").getAttribute("data-executed")).toBeNull();
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
      if (!focused) await pane.getByRole("button", { name: "Ask agent", exact: true }).waitFor();
      break;
  }
}

test("the built CLI publishes every tab view through appearance, focus, close, migration and restart", async () => {
  const { directory, settingsDirectory, launch, cli } = await desktopFixture();
  let application = await launch();
  const failures: string[] = [];
  try {
    let page = await application.firstWindow();
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
      await page.getByRole("button", { name: "Workspace menu", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Workspace", exact: true })
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 700, height: 620 },
      );
      for (const example of examples) {
        await page.getByRole("button", { name: "Find artifacts and tools" }).click();
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
          await page.getByRole("button", { name: "Workspace menu", exact: true }).click();
          await page.getByRole("button", { name: "Download", exact: true }).click();
          await expect.poll(async () => [...(await readFile(destination))]).toEqual([0, 1, 2, 3]);
        }
        const pane = await page
          .getByRole("tabpanel", { name: example.title, exact: true })
          .elementHandle();
        await page.getByRole("button", { name: "Focus artifact" }).click();
        await checkContent(page, example, true);
        await page.getByRole("button", { name: "Exit focus mode" }).click();
        expect(await pane!.evaluate((element) => element.isConnected)).toBe(true);
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-${example.kind}.png`),
          });
        }
      }
    }
    expect(
      await page
        .getByRole("tab")
        .evaluateAll((tabs) => new Set(tabs.map((tab) => tab.getBoundingClientRect().y)).size),
    ).toBe(1);
    for (const example of examples) {
      const tab = page.getByRole("tab", { name: example.title, exact: true });
      await tab.click();
      const id = await tab.getAttribute("id");
      await page.keyboard.press("ControlOrMeta+w");
      await expect.poll(() => page.getByRole("tab").count()).toBe(examples.length - 1);
      await page.keyboard.press("ControlOrMeta+Shift+t");
      await checkContent(page, example);
      expect(await tab.getAttribute("id")).toBe(id);
    }
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(examples.length);
    const visibleIds = await page
      .getByRole("tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.id.slice(4)));
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.scope.workspace()))?.tabs.map((tab) => tab.id),
      )
      .toEqual(visibleIds);
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
    await expect.poll(() => page.getByRole("tab").count()).toBe(examples.length);
    expect(
      (await page.evaluate(() => window.scope.workspace()))?.tabs.map((tab) => tab.id),
    ).toEqual(before?.tabs.map((tab) => tab.id));
    for (const example of examples) {
      await page.getByRole("tab", { name: example.title, exact: true }).click();
      await checkContent(page, example);
    }
    await application.close();
    const db = new DatabaseSync(join(settingsDirectory, "desktop.db"));
    db.prepare("UPDATE preferences SET document = ? WHERE name = 'workspace'").run(
      JSON.stringify({
        tabs: examples.map((example) => example.id),
        selected: "drawing",
        closed: [],
      }),
    );
    db.exec("PRAGMA user_version = 3");
    db.close();
    application = await launch();
    page = await application.firstWindow();
    page.on("pageerror", (error) => failures.push(error.message));
    await checkContent(page, examples[5]);
    for (const example of examples) {
      await page.getByRole("tab", { name: example.title, exact: true }).click();
      await checkContent(page, example);
    }
    expect(failures).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
