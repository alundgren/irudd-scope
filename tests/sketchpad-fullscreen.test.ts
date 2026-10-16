import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("the Sketchpad switches between Edit, View, and Present in fullscreen", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  const fullscreen = () =>
    application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: "Sketchpad", exact: true }).click();
    await page.getByTestId("main-menu-trigger").waitFor();
    const id = (await page.getByRole("tab", { name: "Sketchpad" }).getAttribute("id"))!.slice(4);
    await page.locator(".excalidraw canvas.interactive").click({ position: { x: 300, y: 250 } });
    await page.keyboard.press("r");
    await page.mouse.move(300, 250);
    await page.mouse.down();
    await page.mouse.move(460, 360);
    await page.mouse.up();
    const draft = () => page.evaluate((id) => window.scope.sketchpadDraft(id), id);
    await expect.poll(async () => (await draft())?.content ?? "").toContain("rectangle");

    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect.poll(fullscreen).toBe(true);
    const mode = page.getByRole("combobox", { name: "Fullscreen Sketchpad mode" });
    expect(await mode.inputValue()).toBe("edit");
    await page.getByTestId("main-menu-trigger").waitFor();
    await mode.selectOption("view");
    expect(await page.locator(".excalidraw .layer-ui__wrapper").isVisible()).toBe(false);
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "sketchpad-view.png"),
      });
    }
    await page.mouse.move(400, 300);
    await mode.selectOption("present");
    await page.mouse.move(250, 250, { steps: 5 });
    await expect
      .poll(() =>
        page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
      )
      .toBe("1");
    await page.keyboard.press("Escape");
    expect(await mode.inputValue()).toBe("edit");
    await mode.selectOption("tabs");
    await expect.poll(fullscreen).toBe(false);
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
