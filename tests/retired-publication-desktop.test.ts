import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("HTML and plan controls omit external publishing and preserve the interactive document", async () => {
  const { directory, launch, cli } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(5000);
    const file = join(directory, "review.html");
    await writeFile(file, '<h1>Review page</h1><input aria-label="Review note">');
    await cli("add", file, "--id", "review-html", "--title", "HTML review");
    await cli("add", file, "--plan", "--name", "review-plan", "--title", "Plan review");
    for (const appearance of ["light", "dark"] as const) {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 480, height: 560 },
      );
      for (const title of ["HTML review", "Plan review"]) {
        await page
          .getByRole("button", { name: "Tabs and Trashcan, 2 active tabs", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: title === "HTML review" ? "HTML review html" : "Plan review review-plan · plan",
            exact: true,
          })
          .click();
        const frame = page
          .getByRole("tabpanel", { name: title, exact: true })
          .frameLocator("iframe");
        await frame.getByRole("heading", { name: "Review page" }).waitFor();
        await frame.getByLabel("Review note").fill(`Saved ${appearance} note`);
        await page.getByRole("button", { name: "Search and controls", exact: true }).click();
        const controls = page.getByRole("dialog", { name: "Search and controls", exact: true });
        await controls.getByRole("button", { name: "Download", exact: true }).waitFor();
        expect(
          await controls
            .getByRole("button", { name: "Publish with coding agent", exact: true })
            .count(),
        ).toBe(0);
        await controls.getByRole("button", { name: "Artifact details", exact: true }).click();
        const details = page.getByRole("dialog", { name: title, exact: true });
        await details.waitFor();
        await page.keyboard.press("Escape");
        await details.waitFor({ state: "hidden" });
        expect(await frame.getByLabel("Review note").inputValue()).toBe(`Saved ${appearance} note`);
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await page.getByRole("button", { name: "Search and controls", exact: true }).click();
          await controls.waitFor();
          await controls
            .getByRole("button", { name: "Download", exact: true })
            .scrollIntoViewIfNeeded();
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            path: join(
              process.env.SCOPE_TEST_SCREENSHOTS,
              `${appearance}-${title === "HTML review" ? "html" : "plan"}-controls.png`,
            ),
          });
          await page.keyboard.press("Escape");
          await controls.waitFor({ state: "hidden" });
        }
      }
    }
    await expect(cli("publications", "guide")).rejects.toMatchObject({ code: 1 });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
