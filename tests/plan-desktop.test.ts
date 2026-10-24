import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "native plan reading, recorded bindings, copy, appearance, hide and restart in isolated Electron",
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
      const first = JSON.parse(
        (
          await cli(
            "plan",
            "publish",
            "reading-plan",
            join(example, "plan.json"),
            join(example, "overview.html"),
          )
        ).stdout,
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
      await page.getByRole("button", { name: "Preserve unrelated content", exact: true }).click();
      await page.getByRole("button", { name: "Copy work item", exact: true }).click();
      await page.getByText("Work item copied.", { exact: true }).waitFor();
      const copied = JSON.parse(
        await application.evaluate(({ clipboard }) => clipboard.readText()),
      );
      expect(copied.item.id).toBe("recover");
      expect(copied.ownedChecks.map((x: { id: string }) => x.id)).toEqual(["remove"]);
      expect(copied.prerequisites[0].checks).toHaveLength(2);
      if (process.env.SCOPE_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, "plan-work-items.png"),
        });
      await cli(
        "plan",
        "capture-basis",
        "reading-plan",
        "original",
        "--expected-revision",
        String(first.revision),
      );
      const read = JSON.parse((await cli("plan", "read", "reading-plan")).stdout);
      const proposal = read.document.bases[0].proposal;
      const changed = {
        ...read.document,
        title: "Save a reading list",
        checks: read.document.checks.map((x: { id: string; expectation: string }) => ({
          ...x,
          expectation: x.id === "save" ? "A changed current criterion." : x.expectation,
        })),
        agreements: [
          {
            id: "decision",
            basisId: "original",
            targetIds: ["save"],
            note: "Keep exactly one entry.",
          },
        ],
        evidence: [
          {
            id: "proof",
            basisId: "original",
            checkId: "save",
            expected: "One entry",
            observed: "One entry",
            implementation: "Synthetic build",
            conditions: "Synthetic fixture",
            result: "passed",
          },
        ],
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
      await page.getByRole("button", { name: "Inspect proposal from revision 1" }).click();
      const old = page.frameLocator('iframe[title="Recorded proposal from revision 1"]');
      await old.getByRole("heading", { name: "The ordinary result" }).waitFor();
      await old.locator('[data-plan-procedure="save"] summary').click();
      expect(await old.locator("html").getAttribute("data-expected")).toBe(
        proposal.checks[0].expectation,
      );
      expect(await old.locator('[data-plan-procedure="save"]').textContent()).toContain(
        proposal.checks[0].expectation,
      );
      expect(await old.locator('[data-plan-procedure="save"]').textContent()).not.toContain(
        "A changed current criterion.",
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS)
        await page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, "plan-recorded-basis.png"),
        });
      await page.getByRole("button", { name: "Current proposal", exact: true }).click();
      frame = page.frameLocator('iframe[title="Save a reading list"]');
      await frame.getByText("A changed current criterion.", { exact: true }).waitFor();
      expect(await frame.locator("body").getAttribute("data-expected")).toBe(
        "A changed current criterion.",
      );
      // Restore the long visual to exercise persistence across update and navigation.
      await writeFile(html, await readFile(join(example, "overview.html"), "utf8"));
      await cli("plan", "publish", "reading-plan", json, html, "--expected-revision", "3");
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
      await page.getByRole("button", { name: "Work items", exact: true }).click();
      await page.getByRole("button", { name: "Inspect proposal from revision 1" }).click();
      await old.getByRole("heading", { name: "The ordinary result" }).waitFor();
      await page.getByRole("button", { name: "Current proposal", exact: true }).click();
      await frame.getByRole("heading", { name: "Keep existing work safe" }).waitFor();
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
          .getAttribute("aria-pressed"),
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
