import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "new CLI publications open visible tabs and preserve reading and saved selection while closing retains content in Trashcan",
  { tags: ["tabs-stay-put", "publish", "deletion-is-final"], timeout: 60_000 },
  async () => {
    const { directory, launch, cli } = await desktopFixture({ hideInitialPrompts: true });
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
      expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(
        "First publication",
      );
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
      expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(
        "First publication",
      );
      expect(await pane.evaluate((element) => element.scrollTop)).toBe(scroll);
      expect(await article!.evaluate((element) => element.isConnected)).toBe(true);

      for (const appearance of ["light", "dark"] as const) {
        await page.keyboard.press("ControlOrMeta+,");
        await page.getByRole("button", { name: "Appearance", exact: true }).click();
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
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
      expect(JSON.parse((await cli("get", "second")).stdout).id).toBe("second");
      await expect(cli("update", "second", second)).rejects.toThrow("Trashcan");
      await page.getByRole("button", { name: "Search and controls" }).click();
      expect(
        await page.getByRole("button", { name: "Reopen closed tab", exact: true }).count(),
      ).toBe(0);
      await page.getByLabel("Search artifacts", { exact: true }).fill(title);
      expect(await page.getByRole("button", { name: `${title} text`, exact: true }).count()).toBe(
        0,
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+w");
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      expect(JSON.parse((await cli("list")).stdout)).toHaveLength(2);
      await application.close();
      application = await launch();
      page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
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
  },
);
