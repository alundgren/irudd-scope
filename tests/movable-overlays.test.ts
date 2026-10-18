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
async function drag(
  page: Page,
  frame: Locator,
  x: number,
  y: number,
  edge: "top" | "bottom" | "left" | "right" = "top",
) {
  const rectangle = await bounds(frame);
  const startX =
    rectangle.x +
    (edge === "left" ? 2 : edge === "right" ? rectangle.width - 2 : rectangle.width / 2);
  const startY =
    rectangle.y +
    (edge === "top" ? 2 : edge === "bottom" ? rectangle.height - 2 : rectangle.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + x, startY + y, { steps: 6 });
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

test("fullscreen controls keep their position through focus, resizing, tabs, and restart", async () => {
  const { directory, launch } = await desktopFixture({ hideInitialPrompts: true });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.evaluate(
      (html) => window.scope.createPlan({ name: "focus-plan", title: "Focus plan", html }),
      html,
    );
    await page.frameLocator(".plan-document").getByLabel("Authored draft").fill("Fullscreen draft");
    await page.getByRole("tab", { name: "Focus plan", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    let controls = page.locator(".focus-controls");
    await controls.waitFor();
    const original = await bounds(controls);
    await drag(page, controls, -200, 150);
    await controls.focus();
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
    await page.getByRole("tab", { name: "Other focus plan", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await controls.waitFor();
    await expect.poll(() => bounds(controls)).toEqual(original);
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    await page.getByRole("tab", { name: "Focus plan", exact: true }).click();
    await page.getByRole("tab", { name: "Focus plan", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    await expect.poll(() => bounds(controls)).toEqual(moved);
    await drag(page, controls, 5000, 5000);
    await expect.poll(() => fits(controls, page.locator(".workspace"))).toBe(true);
    await page.setViewportSize({ width: 450, height: 350 });
    await expect.poll(() => fits(controls, page.locator(".workspace"))).toBe(true);
    expect((await bounds(controls)).width).toBeCloseTo(original.width, 1);
    await screenshot(page, "movable-fullscreen-small.png");
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("tab", { name: "Focus plan", exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+f");
    controls = page.locator(".focus-controls");
    await controls.waitFor();
    expect((await bounds(controls)).y).toBeGreaterThan(original.y + 150);
    await controls.focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => (await bounds(controls)).y).toBeCloseTo(original.y, 1);
    await controls.getByRole("combobox", { name: "Fullscreen HTML mode" }).selectOption("tabs");
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
