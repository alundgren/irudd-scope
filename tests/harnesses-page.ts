import { expect } from "vite-plus/test";
import type { Locator, Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Opens the Harnesses tab from search. */
export async function openHarnessesTab(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill("harnesses");
  await page.getByRole("button", { name: "Harnesses", exact: true }).click();
  await page.getByRole("tab", { name: "Harnesses", selected: true }).waitFor();
  // Closing search returns focus to its button.
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

export const scanTime = (page: Page) =>
  page.locator(".harnesses-matrix time").getAttribute("dateTime");

/**
 * Runs `action` while watching `element`; fails when it ever shows "Reading…" or loses
 * `kept`. A scan and a read can finish within one frame, so an observer sees every change.
 */
export async function expectTextKept(element: Locator, kept: string, action: () => Promise<void>) {
  await element.evaluate((node, text) => {
    const flags = window as unknown as { harnessesTextLost?: boolean };
    flags.harnessesTextLost = false;
    new MutationObserver(() => {
      const shown = node.textContent ?? "";
      if (shown.includes("Reading…") || !shown.includes(text)) flags.harnessesTextLost = true;
    }).observe(node, { childList: true, characterData: true, subtree: true });
  }, kept);
  await action();
  expect(
    await element.evaluate(
      () => (window as unknown as { harnessesTextLost?: boolean }).harnessesTextLost,
    ),
  ).toBe(false);
}

/** Saves the tab in both appearances and widths when SCOPE_TEST_SCREENSHOTS names a folder. */
export async function saveScreenshots(page: Page, name: string) {
  const folder = process.env.SCOPE_TEST_SCREENSHOTS;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  for (const appearance of ["light", "dark"] as const) {
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByLabel("Search settings").fill("color scheme");
    await settings.getByLabel("Appearance", { exact: true }).selectOption(appearance);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });
    for (const [width, size] of [
      [1366, "laptop"],
      [600, "narrow"],
    ] as const) {
      await page.setViewportSize({ width, height: 860 });
      await page.screenshot({ path: join(folder, `harnesses-${name}-${appearance}-${size}.png`) });
    }
  }
}
