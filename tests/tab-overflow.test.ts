import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("150 tabs use a searchable overflow picker, keep their order, and survive restart", async () => {
  const { directory, launch, connect } = await desktopFixture();
  let application = await launch();
  try {
    let page = await application.firstWindow();
    let client = await connect();
    for (let index = 0; index < 150; index++) {
      await client.publish(
        `overflow-${index}`,
        {
          title:
            index === 144
              ? "Deployment review: recovering an interrupted publication without losing local edits"
              : index === 143
                ? "API v2.0 / retry notes"
                : `Overflow ${index}`,
          kind: "text",
          mediaType: "text/plain",
          fileName: "note.txt",
          expectedRevision: 0,
        },
        new TextEncoder().encode(`Synthetic ${index}`),
      );
    }
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(150);
    expect(await client.list()).toHaveLength(150);
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe("Overflow 0");
    expect(await page.getByRole("tab").count()).toBeLessThanOrEqual(10);
    expect(await page.locator(".artifact-pane pre").count()).toBe(1);
    await page.getByRole("tab", { name: "Overflow 149", exact: true }).click();
    const leftmost = await page.getByRole("tab").first().textContent();
    const picker = () => page.getByRole("button", { name: /^Tabs and Trashcan,/ });
    await picker().click();
    await expect
      .poll(() =>
        page
          .getByLabel("Search tabs", { exact: true })
          .evaluate((el) => el === document.activeElement),
      )
      .toBe(true);
    expect(await page.locator("[data-tab-result]").count()).toBe(150);
    await page.getByLabel("Search tabs", { exact: true }).fill("missing tab title");
    await page.getByRole("status").filter({ hasText: "No tabs match" }).waitFor();
    await page.getByRole("button", { name: "Clear tab search" }).click();
    await page.getByLabel("Search tabs", { exact: true }).fill("Overflow 42");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.getByRole("tab", { selected: true }).textContent())
      .toBe("Overflow 42");
    expect(await page.getByRole("tab").first().textContent()).toBe("Overflow 42");
    expect(await page.getByRole("tab", { name: leftmost!, exact: true }).count()).toBe(0);
    await page.getByText("Synthetic 42", { exact: true }).waitFor();
    await expect
      .poll(() =>
        page.getByRole("tab", { selected: true }).evaluate((el) => el === document.activeElement),
      )
      .toBe(true);

    for (const appearance of ["light", "dark"] as const) {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByLabel("Search settings").fill("appearance");
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .waitFor({ state: "hidden" });
      await page.setViewportSize(
        appearance === "light" ? { width: 1440, height: 900 } : { width: 700, height: 620 },
      );
      await picker().click();
      await page.getByLabel("Search tabs", { exact: true }).waitFor();
      const bounds = await page.locator(".tab-overflow-popup").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(appearance === "light" ? 900 : 620);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `overflow-${appearance}.png`),
        });
      }
      await page.keyboard.press("Escape");
      await expect.poll(() => picker().evaluate((el) => el === document.activeElement)).toBe(true);
    }
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    client = await connect();
    await page.getByText("Synthetic 42", { exact: true }).waitFor();
    const saved = await page.evaluate(() => window.scope.workspace());
    expect(saved?.tabs).toHaveLength(150);
    expect(saved?.tabs[42]?.title).toBe("Overflow 42");
    expect(await page.getByRole("tab").first().textContent()).toBe("Overflow 42");
    await picker().click();
    await page.getByLabel("Search tabs", { exact: true }).fill("Overflow 42");
    await page.getByRole("button", { name: "Overflow 42 text", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+w");
    expect(await client.get("overflow-42")).toBeDefined();
    for (const artifact of await client.list()) await client.delete(artifact.id);
    await expect.poll(() => page.getByRole("tab").count()).toBe(0);
    expect(await picker().count()).toBe(1);
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("overflow preserves visited HTML, hands focus to dialogs, and remains available when tabs fit", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(5000);
    const client = await f.connect();
    await client.publish(
      "interactive",
      {
        title: "Interactive notes",
        kind: "html",
        mediaType: "text/html",
        fileName: "notes.html",
        expectedRevision: 0,
      },
      Buffer.from(
        "<button onclick=\"this.textContent = 'Clicked'\">Click me</button><label>Draft<input></label>",
      ),
    );
    const html = page.frameLocator('iframe[title="Interactive notes"]');
    await html.getByRole("button", { name: "Click me" }).click();
    await html.getByLabel("Draft").fill("Keep this unsaved input");
    const frame = await page.locator('iframe[title="Interactive notes"]').elementHandle();
    for (let index = 0; index < 12; index++) {
      await client.publish(
        `background-${index}`,
        {
          title: `Background ${index}`,
          kind: "text",
          mediaType: "text/plain",
          fileName: "note.txt",
          expectedRevision: 0,
        },
        Buffer.from(`Background content ${index}`),
      );
    }
    await page.getByRole("tab", { name: "Background 11", exact: true }).waitFor();
    expect(await page.locator(".artifact-pane pre").count()).toBe(0);
    await page.getByRole("tab", { name: "Background 11", exact: true }).click();
    await page.getByText("Background content 11", { exact: true }).waitFor();
    expect(await page.getByRole("tab", { name: "Interactive notes", exact: true }).count()).toBe(0);
    const picker = page.getByRole("button", { name: /^Tabs and Trashcan,/ });
    await picker.click();
    await page.getByLabel("Search tabs", { exact: true }).fill("INTERACTIVE");
    await page.keyboard.press("Enter");
    await html.getByRole("button", { name: "Clicked", exact: true }).waitFor();
    expect(await html.getByLabel("Draft").inputValue()).toBe("Keep this unsaved input");
    expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await page.getByRole("tab").first().textContent()).toBe("Interactive notes");

    for (const [shortcut, input] of [
      ["ControlOrMeta+k", "Search artifacts"],
      ["ControlOrMeta+,", "Search settings"],
    ]) {
      await picker.click();
      await page.getByLabel("Search tabs", { exact: true }).waitFor();
      await page.keyboard.press(shortcut);
      await page.locator(".tab-overflow-popup").waitFor({ state: "hidden" });
      await expect
        .poll(() =>
          page
            .getByLabel(input, { exact: true })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await page.getByLabel(input, { exact: true }).waitFor({ state: "hidden" });
    }

    for (const width of [640, 850, 1280]) {
      await page.setViewportSize({ width, height: 600 });
      await expect
        .poll(() =>
          page
            .getByRole("navigation", { name: "Open artifacts" })
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(
        "Interactive notes",
      );
    }
    await picker.click();
    await page.getByLabel("Search tabs", { exact: true }).fill("Background 0");
    await page.locator("[data-tab-result]").waitFor();
    await client.delete("background-0");
    await page.getByRole("status").filter({ hasText: "No tabs match" }).waitFor();
    await page.keyboard.press("Escape");
    for (const artifact of await client.list()) {
      if (artifact.id !== "interactive") await client.delete(artifact.id);
    }
    await expect.poll(() => page.getByRole("tab").count()).toBe(1);
    expect(await picker.count()).toBe(1);
    expect(await html.getByLabel("Draft").inputValue()).toBe("Keep this unsaved input");
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
