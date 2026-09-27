import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("new CLI publications open visible tabs and preserve reading, closed tabs, and saved selection", async () => {
  const { directory, launch, cli } = await desktopFixture();
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.artifactLibrary()).connection))
      .toBe("connected");
    const first = join(directory, "first.md");
    await writeFile(first, `# First publication\n\n${"Reading stays here.\n\n".repeat(80)}`);
    await cli("add", first, "--id", "first", "--title", "First publication");
    await page.getByRole("heading", { name: "First publication", exact: true }).waitFor();
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe("First publication");
    expect(await page.getByRole("img", { name: "Updated artifact" }).count()).toBe(0);
    const pane = page.getByRole("tabpanel", { name: "First publication" });
    await pane.evaluate((element) => {
      element.scrollTop = 500;
    });
    const scroll = await pane.evaluate((element) => element.scrollTop);
    const article = await pane.locator("article").elementHandle();

    const second = join(directory, "second.txt");
    const title = "Second publication: an overview with a long title for the workspace";
    await writeFile(second, "The background publication is ready to inspect.");
    await cli("add", second, "--id", "second", "--title", title);
    await page.getByRole("tab", { name: title, exact: true }).waitFor();
    await page.getByRole("img", { name: "Updated artifact" }).waitFor();
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe("First publication");
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
    expect(await article!.evaluate((element) => element.isConnected)).toBe(true);

    for (const appearance of ["light", "dark"] as const) {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .waitFor({ state: "hidden" });
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 700, height: 620 },
      );
      expect(await page.getByRole("tab", { name: title, exact: true }).isVisible()).toBe(true);
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `${appearance}-publication-arrival.png`),
        });
      }
    }
    await page.getByRole("tab", { name: title, exact: true }).click();
    await page
      .getByText("The background publication is ready to inspect.", { exact: true })
      .waitFor();
    expect(await page.getByRole("img", { name: "Updated artifact" }).count()).toBe(0);
    await page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => page.getByRole("tab").count()).toBe(1);
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
    await writeFile(second, "The closed artifact received an update.");
    await cli("update", "second", second, "--title", "Closed artifact update");
    await page.getByRole("img", { name: "New artifacts" }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Closed artifact update text", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByLabel("Search artifacts", { exact: true }).waitFor({ state: "hidden" });
    expect(await page.getByRole("tab").count()).toBe(1);
    await page.keyboard.press("ControlOrMeta+w");
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Closed artifact update text", exact: true }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(0);
    const third = join(directory, "third.md");
    await writeFile(third, "# Publication after restart");
    await cli("add", third, "--id", "third", "--title", "Publication after restart");
    await page.getByRole("heading", { name: "Publication after restart" }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(1);
    await application.close();

    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Publication after restart" }).waitFor();
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(
      "Publication after restart",
    );
    expect(await page.getByRole("tab").count()).toBe(1);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("publications wait while a diagram is being composed", async () => {
  const { directory, launch, cli } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Create diagram", exact: true }).click();
    await page
      .getByLabel("What should the diagram show?")
      .fill("Keep this unsent diagram request.");
    const file = join(directory, "arrival.txt");
    await writeFile(file, "The publication arrived while composing.");
    await cli("add", file, "--id", "arrival", "--title", "Publication while composing");
    await page.getByRole("img", { name: "New artifacts" }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(0);
    expect(await page.getByLabel("What should the diagram show?").inputValue()).toBe(
      "Keep this unsent diagram request.",
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("The publication arrived while composing.", { exact: true }).waitFor();
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(
      "Publication while composing",
    );
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the compact workspace preserves reading position, supports overflowing tabs, and searches settings", async () => {
  const { directory, launch, connect } = await desktopFixture();
  let application = await launch();
  try {
    const page = await application.firstWindow();
    const client = await connect();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const searchTrigger = page.getByRole("button", { name: "Search and controls", exact: true });
    await searchTrigger.click();
    const controls = page.getByRole("dialog", { name: "Search and controls", exact: true });
    const searchInput = controls.getByLabel("Search artifacts", { exact: true });
    await expect
      .poll(() => searchInput.evaluate((element) => element === document.activeElement))
      .toBe(true);
    expect(await controls.getByRole("button", { name: "Settings", exact: true }).isVisible()).toBe(
      true,
    );
    expect(await controls.getByRole("button", { name: "Fullscreen", exact: true }).count()).toBe(0);
    expect(await controls.getByRole("button", { name: "Download", exact: true }).count()).toBe(0);
    expect(
      await controls.getByRole("button", { name: "Reopen closed tab", exact: true }).count(),
    ).toBe(0);
    expect(await controls.getByRole("region", { name: "Current tab" }).count()).toBe(0);
    await searchInput.fill("download");
    await controls.getByText("No matches. Try another title, action, or setting.").waitFor();
    await controls.getByRole("button", { name: "Clear search", exact: true }).click();
    await page.keyboard.press("ArrowUp");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent))
      .toBe("Create diagram");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => searchTrigger.evaluate((element) => element === document.activeElement))
      .toBe(true);
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
      await page.getByRole("button", { name: "Search and controls" }).click();
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
    await page.getByRole("button", { name: "Search and controls" }).click();
    const currentTab = controls.getByRole("region", { name: "Current tab" });
    expect(await currentTab.getByText(titles[11], { exact: true }).isVisible()).toBe(true);
    await currentTab.getByRole("button", { name: "Artifact details", exact: true }).click();
    await page
      .getByRole("dialog", { name: titles[11], exact: true })
      .getByText("report-11", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await searchInput.fill("full screen");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Exit focus mode" }).waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    expect(
      await controls.getByRole("button", { name: "Exit fullscreen", pressed: true }).isVisible(),
    ).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("button", { name: "Exit focus mode" }).isVisible()).toBe(true);
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByLabel("Search settings").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("button", { name: "Exit focus mode" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
    expect(await article!.evaluate((element) => element.isConnected)).toBe(true);

    await page.getByRole("button", { name: "Search and controls" }).click();
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
    await searchTrigger.click();
    await currentTab.getByRole("button", { name: "Close tab", exact: true }).click();
    await expect.poll(() => navigation.getByRole("tab").count()).toBe(11);
    await searchTrigger.click();
    expect(await currentTab.getByText(titles[10], { exact: true }).isVisible()).toBe(true);
    await controls.getByRole("button", { name: "Reopen closed tab", exact: true }).click();
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
