import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { desktopFixture } from "./desktop-fixture.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function openSketchpad(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill("sketch");
  await page.getByRole("button", { name: "Sketchpad", exact: true }).click();
  await page.getByRole("tab", { name: "Sketchpad", selected: true }).waitFor();
  await page.getByTestId("main-menu-trigger").waitFor();
  return (await page.getByRole("tab", { name: "Sketchpad" }).getAttribute("id"))!.slice(4);
}

async function addText(page: Page, text: string) {
  await page.locator(".excalidraw canvas.interactive").click({ position: { x: 500, y: 200 } });
  await page.keyboard.press("t");
  await page.mouse.click(400, 300);
  await page.locator("textarea.excalidraw-wysiwyg").fill(text);
  await page.keyboard.press("Escape");
}

async function resetCanvas(page: Page) {
  await page.getByTestId("main-menu-trigger").click();
  await page.getByRole("button", { name: "Reset canvas", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Canvas cleared." }).waitFor();
}

const draft = (page: Page, id: string) =>
  page.evaluate((id) => window.scope.sketchpadDraft(id), id);

function storedDrafts(settingsDirectory: string) {
  const db = new DatabaseSync(join(settingsDirectory, "artifacts/scope.db"));
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM tab_drafts").get()?.n);
  } finally {
    db.close();
  }
}

test("the Sketchpad opens from search, keeps drawings across restart, and Reset leaves no stored row", async () => {
  const f = await desktopFixture({ hideInitialPrompts: true });
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    const id = await openSketchpad(page);
    await page.getByRole("img", { name: "Built-in tab: Sketchpad", exact: true }).waitFor();
    expect(storedDrafts(f.settingsDirectory)).toBe(0);
    await addText(page, "First idea");
    await expect.poll(async () => (await draft(page, id))?.content ?? "").toContain("First idea");

    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    await page.getByRole("tab", { name: "Sketchpad", selected: true }).waitFor();
    await page.getByTestId("main-menu-trigger").waitFor();
    await page.waitForTimeout(1000);
    // Opening an empty editor before the saved canvas loads must not delete it.
    expect((await draft(page, id))?.content).toContain("First idea");

    await resetCanvas(page);
    expect((await draft(page, id))?.content).toContain("First idea");
    await page
      .getByRole("status")
      .filter({ hasText: "Canvas cleared." })
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await page.getByRole("status").filter({ hasText: "Canvas cleared." }).waitFor({
      state: "hidden",
      timeout: 3000,
    });
    expect((await draft(page, id))?.content).toContain("First idea");

    await resetCanvas(page);
    await page.keyboard.press("ControlOrMeta+z");
    await page.getByRole("status").filter({ hasText: "Canvas cleared." }).waitFor({
      state: "hidden",
      timeout: 3000,
    });
    await page.waitForTimeout(500);
    expect((await draft(page, id))?.content).toContain("First idea");

    await resetCanvas(page);
    await page.getByRole("status").filter({ hasText: "Canvas cleared." }).waitFor({
      state: "hidden",
      timeout: 15_000,
    });
    await expect.poll(() => draft(page, id)).toBeNull();
    expect(storedDrafts(f.settingsDirectory)).toBe(0);

    await addText(page, "Hidden idea");
    await expect.poll(async () => (await draft(page, id))?.content ?? "").toContain("Hidden idea");
    await resetCanvas(page);
    // Leaving the Sketchpad during the undo window keeps the reset.
    await page.getByRole("tab", { name: "Sketchpad" }).focus();
    await page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => draft(page, id), { timeout: 3000 }).toBeNull();
    await openSketchpad(page);

    await addText(page, "Second idea");
    await expect.poll(async () => (await draft(page, id))?.content ?? "").toContain("Second idea");
    await resetCanvas(page);
    // Quitting during the undo window keeps the reset the person asked for.
    await application.close();
    expect(storedDrafts(f.settingsDirectory)).toBe(0);
    application = await f.launch();
    page = await application.firstWindow();
    await page.getByRole("tab", { name: "Sketchpad", selected: true }).waitFor();
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 90_000);

test("saving the Sketchpad drops images no drawing uses and agents have no Sketchpad commands", async () => {
  const f = await desktopFixture({ hideInitialPrompts: true });
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    const id = await openSketchpad(page);
    const file = (fileId: string) => ({
      id: fileId,
      mimeType: "image/png",
      dataURL: png,
      created: 1,
    });
    await application.close();
    // Seed while Scope is closed so the open editor's empty-canvas save cannot race it.
    const db = new DatabaseSync(join(f.settingsDirectory, "artifacts/scope.db"));
    try {
      db.prepare("INSERT INTO tab_drafts VALUES (?, ?)").run(
        id,
        JSON.stringify({
          version: 1,
          content: JSON.stringify({
            type: "excalidraw",
            version: 2,
            source: "test",
            elements: [
              {
                type: "image",
                id: "picture",
                x: 100,
                y: 100,
                width: 40,
                height: 40,
                fileId: "used",
                status: "saved",
              },
            ],
            appState: {},
            files: { used: file("used"), unused: file("unused") },
          }),
        }),
      );
    } finally {
      db.close();
    }
    application = await f.launch();
    page = await application.firstWindow();
    await page.getByTestId("main-menu-trigger").waitFor();
    await addText(page, "Caption");
    const before = (await draft(page, id))?.viewport;
    await page.mouse.move(900, 600);
    await page.mouse.wheel(120, 160);
    await expect.poll(async () => (await draft(page, id))?.viewport).not.toEqual(before);
    await expect
      .poll(async () => {
        const saved = await draft(page, id);
        return saved?.content.includes("Caption")
          ? Object.keys(JSON.parse(saved.content).files)
          : [];
      })
      .toEqual(["used"]);

    await expect(f.cli("diagram", "guide")).rejects.toThrow("Unknown command");
    const client = await f.connect();
    const { endpoint, token } = decodeLocalConnection(
      JSON.parse(await readFile(f.connectionFile, "utf8")),
    );
    for (const path of ["/v1/diagrams", "/v1/diagrams/sync", "/v1/diagram-agents"])
      expect(
        (
          await fetch(`${endpoint}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(404);
    expect(await client.list()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
