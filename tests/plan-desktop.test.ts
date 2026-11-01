import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "native plan reading, work item progress, copy, appearance, hide and restart in isolated Electron",
  {
    tags: ["publish", "survives-restart", "tabs-stay-put", "html-runs-like-a-page"],
    timeout: 120_000,
  },
  async () => {
    const { directory, launch, cli } = await desktopFixture({ hideInitialPrompts: true });
    let application = await launch();
    try {
      let page = await application.firstWindow();
      const example = resolve(".agents/skills/irudd-scope/examples/plans/ui");
      await cli(
        "plan",
        "publish",
        "reading-plan",
        join(example, "plan.json"),
        join(example, "overview.html"),
      );
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).click();
      let frame = page.frameLocator('iframe[title="Save a reading list"]');
      await frame.getByRole("heading", { name: "The ordinary result" }).waitFor();
      await frame.getByRole("button", { name: "Repeated saves stay single" }).click();
      await frame.locator('[data-view="repeat"] summary').click();
      expect(await frame.locator('[data-plan-procedure="repeat"]').textContent()).toContain(
        "Send two concurrent Save requests",
      );
      expect(await frame.locator("html").getAttribute("data-canonical-title")).toBe(
        "Save a reading list",
      );
      for (const appearance of ["light", "dark"] as const) {
        await page.keyboard.press("ControlOrMeta+,");
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByLabel("Search settings")
          .fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .waitFor({ state: "hidden" });
        for (const width of [1366, 620]) {
          await page.setViewportSize({ width, height: 768 });
          await page.getByRole("button", { name: "Work items", exact: true }).focus();
          expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Work items");
          expect(await frame.locator("html").evaluate((x) => x.scrollWidth <= x.clientWidth)).toBe(
            true,
          );
          if (process.env.SCOPE_TEST_SCREENSHOTS) {
            await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path: join(process.env.SCOPE_TEST_SCREENSHOTS, `plan-${appearance}-${width}.png`),
            });
          }
        }
      }
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      const clipboard = () => application.evaluate(({ clipboard }) => clipboard.readText());
      await page.getByRole("button", { name: "Copy next-item instruction", exact: true }).click();
      await page.getByText("Next-item instruction copied.", { exact: true }).waitFor();
      expect(await clipboard()).toContain("irudd-scope plan next reading-plan");
      const row = (title: string) => page.locator("tbody tr", { hasText: title }).first();
      expect(await row("Preserve unrelated content").getAttribute("data-waiting")).toBe("true");
      await page.getByRole("button", { name: "Preserve unrelated content", exact: true }).click();
      await page.getByRole("button", { name: "Copy work item", exact: true }).click();
      await page.getByText("Work item instruction copied.", { exact: true }).waitFor();
      const copied = await clipboard();
      expect(copied).toContain("irudd-scope plan item reading-plan recover");
      expect(copied).toContain("irudd-scope plan done reading-plan recover");
      expect(copied).not.toContain("{");
      // Progress recorded by an agent appears in the open tab.
      await cli(
        "plan",
        "evidence",
        "reading-plan",
        "remove",
        "--result",
        "passed",
        "--observed",
        "Other entries stay",
        "--implementation",
        "Synthetic build",
        "--conditions",
        "Two saved entries",
      );
      await cli("plan", "done", "reading-plan", "persist");
      await row("Persist the reading list").getByLabel("Done", { exact: true }).waitFor();
      expect(await row("Preserve unrelated content").getAttribute("data-waiting")).toBeNull();
      await expect
        .poll(() =>
          page
            .locator("summary", { hasText: "Remove a saved article" })
            .locator(".plan-evidence")
            .textContent(),
        )
        .toBe("Passed");
      if (process.env.SCOPE_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, "plan-work-items.png"),
        });
      const read = JSON.parse((await cli("plan", "read", "reading-plan")).stdout);
      const changed = {
        ...read.document,
        checks: read.document.checks.map((x: { id: string; expectation: string }) => ({
          ...x,
          expectation: x.id === "save" ? "A changed current criterion." : x.expectation,
        })),
      };
      const json = join(directory, "changed.json"),
        html = join(directory, "changed.html");
      await writeFile(json, JSON.stringify(changed));
      await writeFile(
        html,
        '<h1 id="ordinary-case">Changed overview</h1><p data-plan-check="save"></p><div id="recovery-case"></div><script>document.body.dataset.expected=window.scopePlan.data.checks[0].expectation</script>',
      );
      await cli(
        "plan",
        "publish",
        "reading-plan",
        json,
        html,
        "--expected-revision",
        String(read.artifact.revision),
      );
      // Changing the done item's check reopens it.
      await expect
        .poll(() => row("Persist the reading list").getByLabel("Done", { exact: true }).count())
        .toBe(0);
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await frame.getByText("A changed current criterion.", { exact: true }).waitFor();
      expect(await frame.locator("body").getAttribute("data-expected")).toBe(
        "A changed current criterion.",
      );
      // Restore the long visual to exercise persistence across update and navigation.
      await writeFile(html, await readFile(join(example, "overview.html"), "utf8"));
      const revision = JSON.parse((await cli("plan", "read", "reading-plan")).stdout).artifact
        .revision;
      await cli(
        "plan",
        "publish",
        "reading-plan",
        json,
        html,
        "--expected-revision",
        String(revision),
      );
      await frame.getByRole("heading", { name: "Keep existing work safe" }).waitFor();
      // The heading can appear before the iframe finishes restoring its saved position.
      await expect
        .poll(async () => {
          await frame.locator("html").evaluate(() => window.scrollTo(0, 600));
          return page.evaluate(
            async () =>
              (await window.scope.workspace())?.tabs.find((x) => x.type === "plan")?.state.data
                .scrollY,
          );
        })
        .toBeGreaterThan(400);
      // Recording progress does not reload the overview.
      await frame.locator("html").evaluate(() => (document.body.dataset.loaded = "once"));
      await cli("plan", "done", "reading-plan", "persist");
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await row("Persist the reading list").getByLabel("Done", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      expect(await frame.locator("body").getAttribute("data-loaded")).toBe("once");
      await expect
        .poll(() => frame.locator("html").evaluate(() => window.scrollY))
        .toBeGreaterThan(400);
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      await expect
        .poll(() => frame.locator("html").evaluate(() => window.scrollY))
        .toBeGreaterThan(400);
      await cli("text", "Other content", "--title", "Other artifact");
      await page.getByRole("tab", { name: "Other artifact", exact: true }).click();
      await page.getByRole("tab", { name: "Save a reading list", exact: true }).click();
      await expect
        .poll(() => frame.locator("html").evaluate(() => window.scrollY))
        .toBeGreaterThan(400);
      await page.keyboard.press("ControlOrMeta+w");
      await page
        .getByRole("tab", { name: "Save a reading list", exact: true })
        .waitFor({ state: "hidden" });
      await application.close();
      application = await launch();
      page = await application.firstWindow();
      expect(
        await page.getByRole("tab", { name: "Save a reading list", exact: true }).count(),
      ).toBe(0);
      await page.getByRole("button", { name: /^Tabs and Trashcan/ }).click();
      await page.getByRole("button", { name: /^Save a reading list reading-plan/ }).click();
      frame = page.frameLocator('iframe[title="Save a reading list"]');
      await frame.getByRole("heading", { name: "Keep existing work safe" }).waitFor();
      await expect
        .poll(() => frame.locator("html").evaluate(() => window.scrollY))
        .toBeGreaterThan(400);
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      expect(
        await page
          .getByRole("button", { name: "Preserve unrelated content", exact: true })
          .getAttribute("aria-expanded"),
      ).toBe("true");
      const nonUi = resolve(".agents/skills/irudd-scope/examples/plans/non-ui");
      await cli(
        "plan",
        "publish",
        "export-plan",
        join(nonUi, "plan.json"),
        join(nonUi, "overview.html"),
      );
      await page.getByRole("tab", { name: "Retry a daily export", exact: true }).click();
      const exportFrame = page.frameLocator('iframe[title="Retry a daily export"]');
      await exportFrame.getByRole("button", { name: "Retry after interruption" }).click();
      await exportFrame.locator('[data-plan-procedure="retry"] summary').click();
      expect(await exportFrame.locator('[data-plan-procedure="retry"]').textContent()).toContain(
        "120 unique IDs",
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, "plan-non-ui.png"),
        });
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
