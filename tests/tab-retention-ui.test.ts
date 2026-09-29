import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopFixture } from "./desktop-fixture.ts";

test("retention drawer keeps Trashcan secondary, restores tabs, and requires two steps to empty it", async () => {
  const f = await desktopFixture();
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(6000);
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    let client = await f.connect();
    for (let index = 0; index < 12; index++)
      await client.publish(
        `retention-${index}`,
        {
          title:
            index === 0
              ? "Release review: recovery, tab order, and the decisions to revisit tomorrow"
              : `Review ${index}`,
          name: `release-review-${index}`,
          kind: "text",
          mediaType: "text/plain",
          fileName: "review.txt",
          expectedRevision: 0,
        },
        Buffer.from(`Synthetic review ${index}`),
      );
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(12);
    const firstTitle = "Release review: recovery, tab order, and the decisions to revisit tomorrow";
    await page
      .getByRole("button", { name: `Keep permanently: ${firstTitle}`, exact: true })
      .click();
    const picker = () => page.getByRole("button", { name: /^More tabs,/ });
    const drawer = () => page.locator(".tab-overflow-popup");
    await picker().click();
    await page.getByLabel("Search tabs", { exact: true }).waitFor();
    expect(await drawer().locator(".tab-overflow-heading").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Trashcan", exact: true }).count()).toBe(1);
    expect(await page.locator(".tab-retention-sections").count()).toBe(0);
    await page.getByRole("button", { name: "Permanent", exact: true }).click();
    expect(await drawer().locator("[data-tab-result]").count()).toBe(1);
    await page.getByLabel("Search tabs", { exact: true }).fill("release-review-0");
    expect(await drawer().locator("[data-tab-result]").count()).toBe(1);
    await page.getByRole("button", { name: "Temporary", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "No tabs match" }).waitFor();
    await page.getByRole("button", { name: "Clear tab search" }).click();
    await page.getByRole("button", { name: "All", exact: true }).click();
    for (const appearance of ["light", "dark"] as const) {
      await page.keyboard.press("Escape");
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
        appearance === "light" ? { width: 1280, height: 820 } : { width: 640, height: 480 },
      );
      await picker().click();
      await page.getByLabel("Search tabs", { exact: true }).waitFor();
      const bounds = await drawer().boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThan(40);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(appearance === "light" ? 820 : 480);
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `retention-${appearance}.png`),
        });
      }
    }
    await drawer().locator("[data-tab-result]").first().focus();
    await page.keyboard.press("Delete");
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(11);
    await page.getByRole("button", { name: "Trashcan", exact: true }).click();
    await page.getByRole("heading", { name: "Trashcan", exact: true }).waitFor();
    expect(await drawer().locator("[data-tab-result]").count()).toBe(1);
    await drawer().locator("[data-tab-result]").click();
    await page.getByRole("tab", { name: firstTitle, selected: true }).waitFor();
    expect(await page.getByRole("tab").last().textContent()).toBe(firstTitle);
    expect(
      await page
        .getByRole("button", { name: `Make temporary: ${firstTitle}`, exact: true })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    client = await f.connect();
    await page.getByRole("tab", { name: firstTitle, selected: true }).waitFor();
    await page
      .getByRole("button", { name: `Make temporary: ${firstTitle}`, exact: true })
      .waitFor();
    const saved = await page.evaluate(() => window.scope.workspace());
    const hidden = saved!.tabs.find((tab) => tab.title === "Review 1")!;
    const db = new DatabaseSync(join(f.settingsDirectory, "artifacts/scope.db"));
    try {
      db.prepare("UPDATE live_tabs SET last_visible_at = ? WHERE id = ?").run(
        Date.now() - 86_400_001,
        hidden.id,
      );
    } finally {
      db.close();
    }
    await page.evaluate(() =>
      window.scope.checkTabRetention(
        Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => tab.id.slice(4)),
      ),
    );
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.workspace())?.tabs.length))
      .toBe(11);
    await picker().click();
    await page.getByRole("button", { name: "Trashcan", exact: true }).click();
    await page.getByRole("button", { name: "Empty Trashcan…", exact: true }).click();
    expect(
      await page.getByRole("button", { name: "Delete 1 tab forever", exact: true }).isDisabled(),
    ).toBe(true);
    const slider = page.getByRole("slider", { name: "Slide to enable deletion" });
    await expect
      .poll(() => slider.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.press("End");
    expect(
      await page.getByRole("button", { name: "Delete 1 tab forever", exact: true }).isEnabled(),
    ).toBe(true);
    expect(await client.get("retention-1")).toBeDefined();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "retention-trash.png"),
      });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole("button", { name: "Empty Trashcan…", exact: true })
          .evaluate((element) => element === document.activeElement),
      )
      .toBe(true);
    await page.keyboard.press("Enter");
    expect(
      await page.getByRole("button", { name: "Delete 1 tab forever", exact: true }).isDisabled(),
    ).toBe(true);
    await expect
      .poll(() => slider.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.press("End");
    await page.getByRole("button", { name: "Delete 1 tab forever", exact: true }).click();
    await page.getByText("Trashcan is empty.", { exact: true }).waitFor();
    await expect(client.get("retention-1")).rejects.toMatchObject({ status: 404 });
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Review 11", exact: true }).click();
    const aging = new DatabaseSync(join(f.settingsDirectory, "artifacts/scope.db"));
    try {
      aging
        .prepare("UPDATE live_tabs SET last_visible_at = ? WHERE permanent = 0")
        .run(Date.now() - 86_400_001);
    } finally {
      aging.close();
    }
    await page.evaluate(() => window.scope.checkTabRetention([]));
    await expect
      .poll(() => page.getByRole("tab", { selected: true }).textContent())
      .toBe(firstTitle);
    expect(await page.getByRole("tab").count()).toBe(1);
    expect(failures).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
