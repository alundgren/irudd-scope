import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

test("the compact workspace preserves reading position, supports overflowing tabs, and searches settings", async () => {
  const { directory, launch, connect } = await desktopFixture();
  let application = await launch();
  try {
    const page = await application.firstWindow();
    const client = await connect();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const titles = Array.from(
      { length: 12 },
      (_, index) => `Report ${index + 1}: a long artifact title for a narrow window`,
    );
    for (let index = 0; index < titles.length; index++) {
      await client.publish(
        `report-${index}`,
        {
          title: titles[index],
          kind: "markdown",
          mediaType: "text/markdown",
          fileName: "report.md",
          expectedRevision: 0,
        },
        new TextEncoder().encode(
          `# Report ${index + 1}\n\n${"A paragraph that leaves enough room to test reading position.\n\n".repeat(60)}`,
        ),
      );
      await page.getByRole("button", { name: "Find artifacts and tools" }).click();
      await page.getByLabel("Search artifacts", { exact: true }).fill(titles[index]);
      await page.getByRole("button", { name: `${titles[index]} markdown`, exact: true }).waitFor();
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: `Report ${index + 1}`, exact: true }).waitFor();
    }
    await page.setViewportSize({ width: 900, height: 700 });
    const navigation = page.getByRole("navigation", { name: "Open artifacts" });
    const last = navigation.getByRole("tab", { name: titles[11] });
    await last.focus();
    await page.keyboard.press("Home");
    await expect
      .poll(() => navigation.getByRole("tab", { selected: true }).textContent())
      .toBe(titles[0]);
    await page.keyboard.press("End");
    await expect
      .poll(() => navigation.getByRole("tab", { selected: true }).textContent())
      .toBe(titles[11]);
    const dimensions = await page.locator(".workspace-bar").evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    expect(dimensions).toEqual({ height: 44, overflow: false });
    const visibleTab = await last.boundingBox();
    expect(visibleTab!.x).toBeGreaterThan(0);
    expect(visibleTab!.x + visibleTab!.width).toBeLessThan(900);
    const pane = page.getByRole("tabpanel", { name: titles[11] });
    await pane.evaluate((element) => {
      element.scrollTop = 500;
    });
    const scroll = await pane.evaluate((element) => element.scrollTop);
    const article = await pane.locator("article").elementHandle();
    await page.getByRole("button", { name: "Focus artifact" }).click();
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByLabel("Search settings").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("button", { name: "Exit focus mode" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
    expect(await article!.evaluate((element) => element.isConnected)).toBe(true);

    await page.getByRole("button", { name: "Find artifacts and tools" }).click();
    await page.getByLabel("Search artifacts", { exact: true }).fill("theme");
    await page.getByRole("button", { name: "Appearance Setting", exact: true }).click();
    expect(await page.getByLabel("Search settings").inputValue()).toBe("theme");
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    expect(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    await page.getByLabel("Search settings").fill("not a setting");
    await page.getByText('No settings match "not a setting".').waitFor();
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.getByLabel("Search settings").fill("credentials");
    expect(await page.getByLabel("OpenRouter API key").isVisible()).toBe(true);
    expect(await page.getByLabel("Appearance", { exact: true }).isVisible()).toBe(false);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);

    await client.publish(
      "report-0",
      {
        title: titles[0],
        kind: "markdown",
        mediaType: "text/markdown",
        fileName: "report.md",
        expectedRevision: 1,
      },
      new TextEncoder().encode("# Updated report"),
    );
    await page.getByRole("img", { name: "Updated artifact" }).first().waitFor();
    expect(await navigation.getByRole("tab", { selected: true }).textContent()).toBe(titles[11]);
    await page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => navigation.getByRole("tab").count()).toBe(11);
    await page.keyboard.press("ControlOrMeta+Shift+t");
    await expect
      .poll(() => navigation.getByRole("tab", { selected: true }).textContent())
      .toBe(titles[11]);
    expect((await client.list()).length).toBe(12);
    expect(errors).toEqual([]);
    await page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => navigation.getByRole("tab").count()).toBe(11);
    await application.close();
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened.getByRole("heading", { name: "Report 11", exact: true }).waitFor();
    await reopened.keyboard.press("ControlOrMeta+Shift+t");
    await reopened.getByRole("heading", { name: "Report 12", exact: true }).waitFor();
    expect(await reopened.locator("html").getAttribute("data-theme")).toBe("dark");
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
