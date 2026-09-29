import { expect, test } from "vite-plus/test";
import type { Locator, Page } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

async function bounds(dialog: Locator) {
  const rectangle = await dialog.boundingBox();
  expect(rectangle).not.toBeNull();
  return rectangle!;
}

async function drag(page: Page, x: number, y: number, deltaX: number, deltaY: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 5 });
  await page.mouse.up();
}

async function screenshot(page: Page, name: string) {
  if (!process.env.SCOPE_TEST_SCREENSHOTS) return;
  await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({
    path: join(process.env.SCOPE_TEST_SCREENSHOTS, name),
    animations: "disabled",
  });
}

test("Settings opens large and supports dragging and resizing without losing form input", async () => {
  const { directory, launch } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    const search = dialog.getByLabel("Search settings");
    await expect
      .poll(() => search.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await expect.poll(() => dialog.evaluate((element) => element.getAnimations().length)).toBe(0);
    const initial = await bounds(dialog);
    expect(initial.width).toBeGreaterThan(1000);
    expect(initial.height).toBeGreaterThan(800);
    expect(initial.x + initial.width / 2).toBeCloseTo(720);
    expect(initial.y + initial.height / 2).toBeCloseTo(500);
    await search.fill("color scheme");
    await dialog.getByLabel("Appearance", { exact: true }).selectOption("light");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("light");
    await search.fill("remotes");
    const pairing = dialog.getByLabel("Pairing URL");
    await pairing.fill("synthetic-unsaved-pairing-url");
    await screenshot(page, "settings-large-light.png");

    const title = await bounds(dialog.getByRole("heading", { name: "Settings", exact: true }));
    await drag(page, title.x + title.width / 2, title.y + title.height / 2, -60, -40);
    let current = await bounds(dialog);
    expect(current.x).toBeCloseTo(initial.x - 60);
    expect(current.y).toBeCloseTo(initial.y - 40);
    expect(current.width).toBe(initial.width);
    expect(current.height).toBe(initial.height);

    const grip = await bounds(dialog.getByRole("button", { name: "Resize Settings" }));
    await drag(page, grip.x + grip.width / 2, grip.y + grip.height / 2, 120, 40);
    current = await bounds(dialog);
    expect(current.width).toBeCloseTo(initial.width + 120);
    expect(current.height).toBeCloseTo(initial.height + 40);
    const enlarged = current;
    await drag(page, current.x + 6, current.y + 6, 80, 60);
    current = await bounds(dialog);
    expect(current.x).toBeCloseTo(enlarged.x + 80);
    expect(current.y).toBeCloseTo(enlarged.y + 60);
    expect(current.x + current.width).toBeCloseTo(enlarged.x + enlarged.width);
    expect(current.y + current.height).toBeCloseTo(enlarged.y + enlarged.height);

    const edges = [
      { position: [0, 0.5], movement: [20, 0], change: [-20, 0] },
      { position: [1, 0.5], movement: [20, 0], change: [20, 0] },
      { position: [0.5, 0], movement: [0, 20], change: [0, -20] },
      { position: [0.5, 1], movement: [0, 20], change: [0, 20] },
    ] as const;
    for (const { position, movement, change } of edges) {
      const before = await bounds(dialog);
      const x = before.x + 2 + (before.width - 4) * position[0];
      const y = before.y + 2 + (before.height - 4) * position[1];
      await drag(page, x, y, movement[0], movement[1]);
      const after = await bounds(dialog);
      expect(after.width).toBeCloseTo(before.width + change[0]);
      expect(after.height).toBeCloseTo(before.height + change[1]);
    }
    expect(await pairing.inputValue()).toBe("synthetic-unsaved-pairing-url");
    const adjusted = await bounds(dialog);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.keyboard.press("ControlOrMeta+,");
    await search.waitFor();
    await expect.poll(() => bounds(dialog)).toEqual(adjusted);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(
      await page
        .getByRole("button", { name: "Search and controls" })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Settings supports keyboard adjustments and stays reachable in a smaller window", async () => {
  const { directory, launch } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    const search = dialog.getByLabel("Search settings");
    await search.fill("color scheme");
    await dialog.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await search.fill("");
    await expect.poll(() => dialog.evaluate((element) => element.getAnimations().length)).toBe(0);
    await screenshot(page, "settings-large-dark.png");
    const initial = await bounds(dialog);
    await page.keyboard.press("Shift+Tab");
    const move = dialog.getByRole("button", { name: "Move Settings" });
    expect(await move.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowUp");
    let current = await bounds(dialog);
    expect(current.x).toBeCloseTo(initial.x - 10);
    expect(current.y).toBeCloseTo(initial.y - 40);
    const resize = dialog.getByRole("button", { name: "Resize Settings" });
    await resize.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowUp");
    current = await bounds(dialog);
    expect(current.width).toBeCloseTo(initial.width - 10);
    expect(current.height).toBeCloseTo(initial.height - 40);

    let grip = await bounds(resize);
    await drag(page, grip.x + grip.width / 2, grip.y + grip.height / 2, -2000, -2000);
    current = await bounds(dialog);
    expect(current.width).toBeGreaterThanOrEqual(480);
    expect(current.height).toBeGreaterThanOrEqual(360);
    const title = await bounds(dialog.getByRole("heading", { name: "Settings", exact: true }));
    await drag(page, title.x + 10, title.y + 10, -2000, -2000);
    current = await bounds(dialog);
    expect(current.x).toBeGreaterThanOrEqual(0);
    expect(current.y).toBeGreaterThanOrEqual(0);
    grip = await bounds(resize);
    await drag(page, grip.x + grip.width / 2, grip.y + grip.height / 2, 3000, 3000);
    current = await bounds(dialog);
    expect(current.x + current.width).toBeLessThanOrEqual(1280);
    expect(current.y + current.height).toBeLessThanOrEqual(820);

    await page.setViewportSize({ width: 420, height: 380 });
    await expect
      .poll(async () => {
        const rect = await bounds(dialog);
        return (
          rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 420 && rect.y + rect.height <= 380
        );
      })
      .toBe(true);
    await dialog.getByRole("button", { name: "Signing certificate", exact: true }).click();
    await dialog.getByText("How to create a certificate", { exact: true }).click();
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const searchPosition = await bounds(search);
    const closePosition = await bounds(close);
    await dialog
      .getByRole("button", { name: "Connect certificate", exact: true })
      .scrollIntoViewIfNeeded();
    expect(await bounds(search)).toEqual(searchPosition);
    expect(await bounds(close)).toEqual(closePosition);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await screenshot(page, "settings-small-dark.png");
    await search.fill("remotes");
    await dialog.getByRole("button", { name: "Pair remote", exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, "settings-remotes-small-dark.png");
    await close.click();
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
