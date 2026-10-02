import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

for (const appearance of ["light", "dark"] as const) {
  test(`closing permanent tabs defers them while preserving content and selection in ${appearance} appearance`, async () => {
    const f = await desktopFixture();
    let application = await f.launch();
    try {
      let page = await application.firstWindow();
      page.setDefaultTimeout(6000);
      const client = await f.connect();
      const title = "Repository inbox: pull requests and review notes to revisit tomorrow";
      for (const [index, name] of [title, "Bravo", "Charlie"].entries()) {
        await client.publish(
          `close-${index}`,
          {
            title: name,
            kind: "html",
            mediaType: "text/html",
            fileName: "review.html",
            expectedRevision: 0,
          },
          Buffer.from("<!doctype html><label>Review note <input></label>"),
        );
      }
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      await page.getByRole("button", { name: `Keep permanently: ${title}`, exact: true }).click();
      await page.getByRole("button", { name: `Make temporary: ${title}`, exact: true }).waitFor();
      const permanentId = await page.getByRole("tab", { name: title }).getAttribute("id");
      const order = () =>
        page.evaluate(async () => (await window.scope.workspace())?.tabs.map((tab) => tab.title));
      await expect.poll(order).toEqual([title, "Bravo", "Charlie"]);
      const note = () => page.frameLocator(`iframe[title="${title}"]`).getByLabel("Review note");
      await note().fill("Keep this unsaved browser state");

      await page.getByRole("tab", { name: title }).focus();
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByLabel("Search settings").fill("appearance");
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .waitFor({ state: "hidden" });
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 640, height: 480 },
      );
      const closeButton = page.getByRole("button", { name: `Close ${title}`, exact: true });
      expect(await closeButton.getAttribute("title")).toBe("Move to end of queue");
      await closeButton.click();
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      expect(
        await page
          .getByRole("tab", { name: "Bravo" })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);

      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      const drawer = page.locator(".tab-overflow-popup");
      expect(await drawer.locator("[data-tab-result]").allTextContents()).toEqual([
        "Bravo",
        "Charlie",
        title,
      ]);
      await drawer.getByRole("button", { name: "Trashcan", exact: true }).click();
      await page.getByText("Trashcan is empty.", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: title }).click();
      expect(await note().inputValue()).toBe("Keep this unsaved browser state");
      expect(await page.getByRole("tab", { name: title }).getAttribute("id")).toBe(permanentId);
      await page.keyboard.press("ControlOrMeta+w");
      const neighbor = page.getByRole("tab", { name: "Charlie", selected: true });
      await neighbor.waitFor();
      await expect
        .poll(() => neighbor.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.getByRole("tab", { name: title }).focus();
      await page.keyboard.press("Alt+ArrowLeft");
      await expect.poll(order).toEqual(["Bravo", title, "Charlie"]);
      await closeButton.click();
      await page.getByRole("tab", { name: "Charlie", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      await application.close();

      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(6000);
      await page.getByRole("tab", { name: "Charlie", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      expect(await page.getByRole("tab", { name: title }).getAttribute("id")).toBe(permanentId);
      expect(
        await page
          .getByRole("button", { name: `Make temporary: ${title}`, exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");

      await page.getByRole("button", { name: "Close Charlie", exact: true }).click();
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await page.keyboard.press("ControlOrMeta+w");
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      await page.keyboard.press("ControlOrMeta+w");
      await expect.poll(order).toEqual([title]);
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      await page.getByRole("button", { name: "Search and controls", exact: true }).click();
      await page.getByRole("button", { name: "Move to Trashcan", exact: true }).click();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const retained = await page.evaluate(() => window.scope.retainedTabs());
      expect(retained).toHaveLength(3);
      expect(retained.every((entry) => entry.trashedAt !== null)).toBe(true);
      expect(retained.find((entry) => entry.tab.id === permanentId!.slice(4))?.permanent).toBe(
        true,
      );
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    } finally {
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  }, 60_000);
}
