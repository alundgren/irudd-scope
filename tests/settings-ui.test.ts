import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { emptyScene } from "../apps/desktop/src/plugins/diagram/contract.ts";

test("Settings starts with folded sections, opens search matches, and preserves input", async () => {
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
    const enable = settings.getByRole("switch", { name: "Diagram generation", exact: true });
    expect(await enable.getAttribute("aria-checked")).toBe("false");
    expect(await key.isVisible()).toBe(false);
    await enable.focus();
    await page.keyboard.press("Space");
    const provider = settings.getByRole("button", { name: "OpenRouter", exact: true });
    await provider.click();
    await key.fill("synthetic-unsaved-key");
    await provider.click();
    expect(await key.isVisible()).toBe(false);
    await provider.click();
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
        await search.fill("diagram generation");
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `diagram-settings-${theme}.png`),
          animations: "disabled",
        });
        await search.fill("");
      }
    }

    const close = settings.getByRole("button", { name: "Close", exact: true });
    expect(await settings.getByRole("button", { name: "Done", exact: true }).count()).toBe(0);
    await settings.getByRole("button", { name: "Signing certificate", exact: true }).click();
    await settings.getByText("How to create a certificate", { exact: true }).click();
    const searchPosition = await search.boundingBox();
    const closePosition = await close.boundingBox();
    await settings
      .getByRole("button", { name: "Connect certificate", exact: true })
      .scrollIntoViewIfNeeded();
    expect(await search.boundingBox()).toEqual(searchPosition);
    expect(await close.boundingBox()).toEqual(closePosition);
    await search.fill("credentials");
    await key.waitFor();
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "settings-search-dark.png"),
        animations: "disabled",
      });
    }
    await close.click();
    await settings.waitFor({ state: "hidden" });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared key checks require an open OpenRouter section and failed access can be retried", async () => {
  const { directory, launch } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await expect(
      page.evaluate(
        (scene) => window.scope.generateDiagram({ intent: "Draw a browser", scene }),
        emptyScene(),
      ),
    ).rejects.toThrow("Enable diagram generation");
    const initial = await page.evaluate(() => window.scope.settings());
    await application.evaluate(({ ipcMain }, settings) => {
      const access = { checks: 0, fail: true, hasApiKey: false };
      Object.assign(globalThis, { scopeTestDiagramAccess: access });
      ipcMain.removeHandler("scope:provider-settings");
      ipcMain.handle("scope:provider-settings", () => {
        access.checks++;
        return {
          ...settings,
          diagramGenerationEnabled: true,
          hasApiKey: access.fail ? null : access.hasApiKey,
          ...(access.fail
            ? { credentialError: "Key status is unavailable. Retry to request access again." }
            : {}),
        };
      });
    }, initial);
    const checks = () =>
      application.evaluate(
        () =>
          (globalThis as unknown as { scopeTestDiagramAccess: { checks: number } })
            .scopeTestDiagramAccess.checks,
      );

    await page.keyboard.press("ControlOrMeta+,");
    await page.getByLabel("Search settings").fill("diagram generation");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const search = settings.getByLabel("Search settings");
    const enable = settings.getByRole("switch", { name: "Diagram generation", exact: true });
    const key = settings.getByLabel("OpenRouter API key");
    expect(await enable.getAttribute("aria-checked")).toBe("false");
    expect(await key.isVisible()).toBe(false);
    expect(await checks()).toBe(0);
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "diagram-generation-off.png"),
        animations: "disabled",
      });
    }

    await enable.click();
    expect(await checks()).toBe(0);
    await search.fill("credentials");
    await settings.getByText("Key status unavailable", { exact: true }).waitFor();
    expect(await checks()).toBe(1);
    expect(await settings.getByText("No key saved", { exact: true }).isVisible()).toBe(false);
    await application.evaluate(() => {
      (
        globalThis as unknown as { scopeTestDiagramAccess: { fail: boolean } }
      ).scopeTestDiagramAccess.fail = false;
    });
    await settings.getByRole("button", { name: "Retry key access" }).click();
    await settings.getByText("No key saved", { exact: true }).waitFor();
    expect(await checks()).toBe(2);
    await key.fill("synthetic-diagram-key");
    await settings.getByRole("button", { name: "Save key", exact: true }).click();
    await settings.getByText("Key saved", { exact: true }).waitFor();
    await application.evaluate(() => {
      (
        globalThis as unknown as { scopeTestDiagramAccess: { hasApiKey: boolean } }
      ).scopeTestDiagramAccess.hasApiKey = true;
    });

    await search.fill("theme");
    await settings.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await settings.getByText("Settings saved.", { exact: true }).waitFor();
    await search.fill("no matching setting");
    await settings.getByRole("button", { name: "Clear search" }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+,");
    await search.waitFor();
    expect(await key.isVisible()).toBe(false);
    expect(await checks()).toBe(2);
    await search.fill("credentials");
    await settings.getByText("Key saved", { exact: true }).waitFor();
    expect(await checks()).toBe(3);
    await search.fill("diagram generation");
    await enable.click();
    await expect.poll(() => enable.getAttribute("aria-checked")).toBe("false");
    expect(await key.isVisible()).toBe(false);
    await search.fill("theme");
    await search.fill("diagram generation");
    expect(await checks()).toBe(3);
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+,");
    await search.fill("diagram generation");
    await enable.click();
    await search.fill("credentials");
    await settings.getByText("Key saved", { exact: true }).waitFor();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("generation switches show confirmed state and allow retry after a failed save", async () => {
  const { directory, launch } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const search = settings.getByLabel("Search settings");
    await search.fill("generation");
    const diagram = settings.getByRole("switch", { name: "Diagram generation", exact: true });
    const voice = settings.getByRole("switch", { name: "Voice generation", exact: true });
    const diagramRow = settings.locator(".setting-switch").filter({
      has: page.getByRole("switch", { name: "Diagram generation", exact: true }),
    });
    const voiceRow = settings.locator(".setting-switch").filter({
      has: page.getByRole("switch", { name: "Voice generation", exact: true }),
    });
    await diagram.waitFor();
    await voice.waitFor();
    expect(await diagram.getAttribute("aria-checked")).toBe("false");
    expect(await diagramRow.getByText("Off", { exact: true }).isVisible()).toBe(true);
    await voice.focus();
    await page.keyboard.press("Space");
    await expect.poll(() => voice.getAttribute("aria-checked")).toBe("true");
    expect(await voiceRow.getByText("On", { exact: true }).isVisible()).toBe(true);

    const initial = await page.evaluate(() => window.scope.settings());
    await application.evaluate(({ ipcMain }, saved) => {
      const state = {
        saved,
        failNext: true,
        reject: undefined as (() => void) | undefined,
      };
      Object.assign(globalThis, { scopeTestSwitchSave: state });
      ipcMain.removeHandler("scope:save-settings");
      ipcMain.handle("scope:save-settings", (_event, input) => {
        if (state.failNext) {
          return new Promise<never>((_resolve, reject) => {
            state.reject = () => {
              state.failNext = false;
              reject(new Error("Synthetic settings save failure."));
            };
          });
        }
        state.saved = { ...state.saved, ...input };
        return state.saved;
      });
    }, initial);
    await diagramRow.locator("label").click();
    await expect.poll(() => diagram.isDisabled()).toBe(true);
    expect(await voice.isDisabled()).toBe(true);
    expect(await diagram.getAttribute("aria-checked")).toBe("false");
    expect(await diagramRow.getByText("Off", { exact: true }).isVisible()).toBe(true);
    await application.evaluate(() => {
      (
        globalThis as unknown as { scopeTestSwitchSave: { reject: () => void } }
      ).scopeTestSwitchSave.reject();
    });
    await settings
      .getByRole("status")
      .filter({ hasText: "Synthetic settings save failure." })
      .waitFor();
    expect(await diagram.isEnabled()).toBe(true);
    expect(await voice.isEnabled()).toBe(true);
    expect(await diagram.getAttribute("aria-checked")).toBe("false");
    expect(await diagramRow.getByText("Off", { exact: true }).isVisible()).toBe(true);
    await diagramRow.locator("label").click();
    await expect.poll(() => diagram.getAttribute("aria-checked")).toBe("true");
    expect(await diagramRow.getByText("On", { exact: true }).isVisible()).toBe(true);
    await diagram.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => diagram.getAttribute("aria-checked")).toBe("false");

    for (const theme of ["light", "dark"]) {
      await search.fill("appearance");
      await settings.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme);
      await search.fill("generation");
      await page.setViewportSize(
        theme === "light" ? { width: 1280, height: 820 } : { width: 480, height: 680 },
      );
      await diagram.focus();
      expect(await diagram.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await diagramRow.getByText("Off", { exact: true }).isVisible()).toBe(true);
      expect(await voiceRow.getByText("On", { exact: true }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      expect(await settings.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false,
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `generation-switches-${theme}.png`),
          animations: "disabled",
        });
      }
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
