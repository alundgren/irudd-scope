import { expect, test } from "vite-plus/test";
import type { Locator, Page } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

const html = `<!doctype html><html><body style="margin:0;padding:40px;height:1600px"><h1>Movable controls</h1><input aria-label="Authored draft"><button onclick="this.textContent='Clicked'">Authored action</button></body></html>`;
async function bounds(locator: Locator) {
  const rectangle = await locator.boundingBox();
  expect(rectangle).not.toBeNull();
  return rectangle!;
}
async function drag(page: Page, handle: Locator, x: number, y: number) {
  const rectangle = await bounds(handle);
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rectangle.x + rectangle.width / 2 + x,
    rectangle.y + rectangle.height / 2 + y,
    { steps: 6 },
  );
  await page.mouse.up();
}
async function fits(overlay: Locator, container: Locator) {
  const rectangle = await bounds(overlay);
  const area = await bounds(container);
  return (
    rectangle.x >= area.x &&
    rectangle.y >= area.y &&
    rectangle.x + rectangle.width <= area.x + area.width + 1 &&
    rectangle.y + rectangle.height <= area.y + area.height + 1
  );
}
async function screenshot(page: Page, name: string) {
  if (!process.env.SCOPE_TEST_SCREENSHOTS) return;
  await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.SCOPE_TEST_SCREENSHOTS, name) });
}

test("plan controls and feedback move without resetting HTML and persist separately per tab", async () => {
  const { directory, launch } = await desktopFixture();
  let application = await launch();
  try {
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 780),
    );
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.evaluate(
      (html) => window.scope.createPlan({ name: "moving-plan", title: "Moving plan", html }),
      html,
    );
    let pane = page.getByRole("tabpanel", { name: "Moving plan" });
    const frame = pane.frameLocator(".plan-document");
    await frame.getByLabel("Authored draft").fill("Keep this draft");
    await frame.getByRole("button", { name: "Authored action" }).click();
    let toolbar = pane.locator(".plan-controls");
    const original = await bounds(toolbar);
    const grip = await bounds(pane.getByRole("button", { name: "Move plan controls" }));
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x - 150, grip.y + 100);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await bounds(toolbar)).toEqual(original);
    await drag(page, pane.getByRole("button", { name: "Move plan controls" }), -350, 120);
    await expect.poll(async () => (await bounds(toolbar)).x).toBeCloseTo(original.x - 350, 1);
    expect((await bounds(toolbar)).y).toBeCloseTo(original.y + 120, 1);
    await pane.getByRole("button", { name: "Feedback", exact: true }).click();
    let review = pane.getByRole("complementary", { name: "Plan feedback" });
    const reviewOriginal = await bounds(review);
    await drag(page, review.getByRole("button", { name: "Move Feedback panel" }), -400, 180);
    await review.getByRole("button", { name: "Move Feedback panel" }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowDown");
    expect((await bounds(review)).x).toBeCloseTo(reviewOriginal.x - 410, 1);
    expect((await bounds(review)).y).toBeCloseTo(reviewOriginal.y + 220, 1);
    await review.getByLabel("Version", { exact: true }).selectOption("1");
    expect(await frame.getByLabel("Authored draft").inputValue()).toBe("Keep this draft");
    expect(await frame.getByRole("button", { name: "Clicked" }).count()).toBe(1);
    await screenshot(page, "movable-plan-light.png");

    await page.evaluate(
      (html) => window.scope.createPlan({ name: "other-plan", title: "Other plan", html }),
      html,
    );
    await page.getByRole("tab", { name: "Other plan", exact: true }).click();
    const otherPane = page.getByRole("tabpanel", { name: "Other plan" });
    await otherPane.getByRole("button", { name: "Move plan controls" }).waitFor();
    const otherDefault = await bounds(otherPane.locator(".plan-controls"));
    expect(otherDefault.x).toBeCloseTo(original.x, 1);
    expect(otherDefault.y).toBeCloseTo(original.y, 1);
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(500, 420),
    );
    await page.getByRole("tab", { name: "Moving plan", exact: true }).click();
    await expect.poll(() => fits(toolbar, pane.locator(".plan-view"))).toBe(true);
    await expect.poll(() => fits(review, pane.locator(".plan-page"))).toBe(true);
    expect(await frame.getByLabel("Authored draft").inputValue()).toBe("Keep this draft");
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
    await screenshot(page, "movable-plan-small-dark.png");
    const savedToolbar = await bounds(toolbar);
    const savedReview = await bounds(review);
    await review.getByRole("button", { name: "Hide feedback" }).click();
    await pane.getByRole("button", { name: "Feedback", exact: true }).click();
    expect(await bounds(review)).toEqual(savedReview);
    await application.close();
    application = await launch();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(500, 420),
    );
    page = await application.firstWindow();
    pane = page.getByRole("tabpanel", { name: "Moving plan" });
    toolbar = pane.locator(".plan-controls");
    review = pane.getByRole("complementary", { name: "Plan feedback" });
    await review.waitFor();
    await expect.poll(() => bounds(toolbar)).toEqual(savedToolbar);
    await expect.poll(() => bounds(review)).toEqual(savedReview);
    await toolbar.getByRole("button", { name: "Move plan controls" }).focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => (await bounds(toolbar)).y).toBeCloseTo(original.y, 1);
    const reset = await bounds(toolbar);
    const container = await bounds(pane.locator(".plan-view"));
    expect(container.x + container.width - reset.x - reset.width).toBeCloseTo(12, 1);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fullscreen controls keep their position through focus, resizing, tabs, and restart", async () => {
  const { directory, launch } = await desktopFixture();
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.evaluate(
      (html) => window.scope.createPlan({ name: "focus-plan", title: "Focus plan", html }),
      html,
    );
    await page.frameLocator(".plan-document").getByLabel("Authored draft").fill("Fullscreen draft");
    await page.getByRole("button", { name: "Move plan controls" }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    let controls = page.locator(".focus-controls");
    let move = controls.getByRole("button", { name: "Move fullscreen controls" });
    await move.waitFor();
    const original = await bounds(controls);
    await drag(page, move, -200, 150);
    await move.focus();
    await page.keyboard.press("ArrowLeft");
    expect((await bounds(controls)).x).toBeCloseTo(original.x - 210, 1);
    expect((await bounds(controls)).y).toBeCloseTo(original.y + 150, 1);
    const moved = await bounds(controls);
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("present");
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    expect(
      await page.frameLocator(".plan-document").getByLabel("Authored draft").inputValue(),
    ).toBe("Fullscreen draft");
    await page.evaluate(
      (html) =>
        window.scope.createPlan({ name: "other-focus-plan", title: "Other focus plan", html }),
      html,
    );
    await page.getByRole("tab", { name: "Other focus plan", exact: true }).click();
    await page
      .getByRole("tabpanel", { name: "Other focus plan" })
      .getByRole("button", { name: "Move plan controls" })
      .focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await move.waitFor();
    await expect.poll(() => bounds(controls)).toEqual(original);
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    await page.getByRole("tab", { name: "Focus plan", exact: true }).click();
    await page
      .getByRole("tabpanel", { name: "Focus plan" })
      .getByRole("button", { name: "Move plan controls" })
      .focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect.poll(() => bounds(controls)).toEqual(moved);
    await drag(page, move, 5000, 5000);
    await expect.poll(() => fits(controls, page.locator(".workspace"))).toBe(true);
    await page.setViewportSize({ width: 450, height: 350 });
    await expect.poll(() => fits(controls, page.locator(".workspace"))).toBe(true);
    await screenshot(page, "movable-fullscreen-small.png");
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("tab", { name: "Focus plan", exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    controls = page.locator(".focus-controls");
    move = controls.getByRole("button", { name: "Move fullscreen controls" });
    await move.waitFor();
    expect((await bounds(controls)).y).toBeGreaterThan(original.y + 150);
    await move.focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => (await bounds(controls)).y).toBeCloseTo(original.y, 1);
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
