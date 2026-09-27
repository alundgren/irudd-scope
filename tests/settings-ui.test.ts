import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("Settings starts compact, opens search matches, and preserves input across folded sections", async () => {
  const { directory, launch } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const search = settings.getByLabel("Search settings");
    const appearance = settings.getByRole("button", { name: "Appearance", exact: true });
    const diagram = settings.getByRole("button", { name: "Diagram generation", exact: true });
    const key = settings.getByLabel("OpenRouter API key");
    await expect
      .poll(() => search.evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(await settings.getByLabel("Appearance", { exact: true }).isVisible()).toBe(false);
    expect(await key.isVisible()).toBe(false);
    expect(await settings.getByLabel("Pairing URL").isVisible()).toBe(false);

    await page.keyboard.press("Tab");
    expect(await appearance.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await settings.getByLabel("Appearance", { exact: true }).waitFor();
    await page.keyboard.press("Space");
    expect(await settings.getByLabel("Appearance", { exact: true }).isVisible()).toBe(false);

    await diagram.click();
    await key.fill("synthetic-unsaved-key");
    await diagram.click();
    expect(await key.isVisible()).toBe(false);
    await diagram.click();
    expect(await key.inputValue()).toBe("synthetic-unsaved-key");
    await search.fill("theme");
    await settings.getByLabel("Appearance", { exact: true }).waitFor();
    expect(await key.isVisible()).toBe(false);
    await search.fill("api key");
    await key.waitFor();
    expect(await key.inputValue()).toBe("synthetic-unsaved-key");
    await settings.getByRole("button", { name: "Save key", exact: true }).click();
    await settings.getByText("Settings saved.", { exact: true }).waitFor();
    expect(await key.inputValue()).toBe("");
    await settings.getByText("Key saved", { exact: true }).waitFor();

    await search.fill("no matching setting");
    await settings.getByText('No settings match "no matching setting".').waitFor();
    await settings.getByRole("button", { name: "Clear search", exact: true }).click();
    expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await key.isVisible()).toBe(false);
    expect(await settings.getByLabel("Appearance", { exact: true }).isVisible()).toBe(false);

    for (const theme of ["light", "dark"]) {
      await search.fill("color scheme");
      await settings.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme);
      await search.fill("");
      await page.setViewportSize(
        theme === "light" ? { width: 1280, height: 820 } : { width: 640, height: 620 },
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `settings-${theme}.png`),
          animations: "disabled",
        });
      }
    }

    const done = settings.getByRole("button", { name: "Done", exact: true });
    await settings.getByRole("button", { name: "Signing certificate", exact: true }).click();
    await settings.getByText("How to create a certificate", { exact: true }).click();
    const searchPosition = await search.boundingBox();
    const donePosition = await done.boundingBox();
    await settings
      .getByRole("button", { name: "Connect certificate", exact: true })
      .scrollIntoViewIfNeeded();
    expect(await search.boundingBox()).toEqual(searchPosition);
    expect(await done.boundingBox()).toEqual(donePosition);
    await search.fill("credentials");
    await key.waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "settings-search-dark.png"),
        animations: "disabled",
      });
    }
    await done.click();
    await settings.waitFor({ state: "hidden" });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
