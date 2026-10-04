import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

for (const appearance of ["light", "dark"] as const) {
  test(`closing permanent tabs hides them while preserving content and selection in ${appearance} appearance`, async () => {
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
            name: `close-name-${index}`,
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
      await page.getByRole("button", { name: "Search and controls", exact: true }).click();
      await page.getByRole("button", { name: "Artifact details", exact: true }).click();
      const details = page.getByRole("dialog", { name: title, exact: true });
      await details.getByText("Name", { exact: true }).waitFor();
      await details.getByText("close-name-0", { exact: true }).waitFor();
      await details.getByText("close-0", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      const note = () => page.frameLocator(`iframe[title="${title}"]`).getByLabel("Review note");
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
      await note().fill("Keep this unsaved browser state");
      expect(await note().inputValue()).toBe("Keep this unsaved browser state");
      const closeButton = page.getByRole("button", { name: `Close ${title}`, exact: true });
      expect(await closeButton.getAttribute("title")).toBe("Close tab · Reopen from drawer");
      await closeButton.click();
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      expect(await page.getByRole("tab", { name: title }).count()).toBe(0);
      expect(
        await page.evaluate(
          async () =>
            (await window.scope.workspace())?.tabs.find((tab) =>
              tab.title.startsWith("Repository inbox:"),
            )?.hidden,
        ),
      ).toBe(true);
      await expect
        .poll(() =>
          page
            .getByRole("tab", { name: "Bravo" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);

      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      const drawer = page.locator(".tab-overflow-popup");
      expect(await drawer.locator("[data-tab-result]").allTextContents()).toEqual([
        "Bravo",
        "Charlie",
        title,
      ]);
      await drawer.getByRole("button", { name: "Trashcan", exact: true }).click();
      await page.getByText("Trashcan is empty.", { exact: true }).waitFor();
      await drawer.getByRole("button", { name: "Active", exact: true }).click();
      await drawer.locator("[data-tab-result]").filter({ hasText: title }).click();
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      expect(await note().inputValue()).toBe("Keep this unsaved browser state");
      expect(await page.getByRole("tab", { name: title }).getAttribute("id")).toBe(permanentId);
      await page.keyboard.press("ControlOrMeta+w");
      const neighbor = page.getByRole("tab", { name: "Charlie", selected: true });
      await neighbor.waitFor();
      await expect
        .poll(() => neighbor.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await drawer.locator("[data-tab-result]").filter({ hasText: title }).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect.poll(order).toEqual(["Bravo", title, "Charlie"]);
      await drawer.locator("[data-tab-result]").filter({ hasText: title }).click();
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      expect(await note().inputValue()).toBe("Keep this unsaved browser state");
      await closeButton.click();
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      await application.close();

      application = await f.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(6000);
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await expect.poll(order).toEqual(["Bravo", "Charlie", title]);
      expect(await page.getByRole("tab", { name: title }).count()).toBe(0);
      await page.setViewportSize({ width: 1600, height: 900 });
      expect(await page.getByRole("tab", { name: title }).count()).toBe(0);

      await page.getByRole("button", { name: "Close Charlie", exact: true }).click();
      await page.getByRole("tab", { name: "Bravo", selected: true }).waitFor();
      await page.keyboard.press("ControlOrMeta+w");
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await expect.poll(order).toEqual([title]);
      expect(await page.getByRole("tab").count()).toBe(0);
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.workspace()))?.selected)
        .toBeNull();
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await page
        .locator(".tab-overflow-popup [data-tab-result]")
        .filter({ hasText: title })
        .click();
      await page.getByRole("tab", { name: title, selected: true }).waitFor();
      expect(await page.getByRole("tab", { name: title }).getAttribute("id")).toBe(permanentId);
      await page.keyboard.press("ControlOrMeta+w");
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await expect
        .poll(async () => (await page.evaluate(() => window.scope.workspace()))?.selected)
        .toBeNull();
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      expect(await page.getByRole("tab").count()).toBe(0);
      await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
      await page
        .locator(".tab-overflow-popup [data-tab-result]")
        .filter({ hasText: title })
        .click();
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

test("background revisions, new publications, and arrow shortcuts leave closed permanent tabs hidden", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    const client = await f.connect();
    const publish = (id: string, revision = 0) =>
      client.publish(
        id.toLowerCase().replaceAll(" ", "-"),
        {
          title: id,
          kind: "text",
          mediaType: "text/plain",
          fileName: "note.txt",
          expectedRevision: revision,
        },
        Buffer.from(`${id} revision ${revision + 1}`),
      );
    await publish("Saved tool");
    await publish("Active artifact");
    await page.getByRole("button", { name: "Keep permanently: Saved tool", exact: true }).click();
    await page.getByRole("button", { name: "Make temporary: Saved tool", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close Saved tool", exact: true }).click();
    await page.getByRole("tab", { name: "Active artifact", selected: true }).waitFor();
    await publish("Saved tool", 1);
    await publish("New arrival");
    await page.getByRole("tab", { name: "New arrival" }).waitFor();
    expect(await page.getByRole("tab", { name: "Saved tool" }).count()).toBe(0);
    await page.getByRole("tab", { name: "Active artifact" }).focus();
    await page.keyboard.press("End");
    await page.getByRole("tab", { name: "New arrival", selected: true }).waitFor();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("tab", { name: "Active artifact", selected: true }).waitFor();
    expect(await page.getByRole("tab", { name: "Saved tool" }).count()).toBe(0);
    await page.getByRole("button", { name: "Search and controls", exact: true }).click();
    await page.getByRole("button", { name: "Artifact details", exact: true }).click();
    expect(
      await page
        .getByRole("dialog", { name: "Active artifact", exact: true })
        .getByText("Name", { exact: true })
        .count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    await page
      .locator(".tab-overflow-popup [data-tab-result]")
      .filter({ hasText: "Saved tool" })
      .click();
    await page.getByText("Saved tool revision 2", { exact: true }).waitFor();
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a failed close-state save keeps a permanent tab visible for retry", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    const client = await f.connect();
    await client.publish(
      "close-save-failure",
      {
        title: "Saved tool",
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        expectedRevision: 0,
      },
      Buffer.from("Keep this tab visible"),
    );
    await page.getByRole("button", { name: "Keep permanently: Saved tool", exact: true }).click();
    await page.getByRole("button", { name: "Make temporary: Saved tool", exact: true }).waitFor();
    await application.evaluate(({ ipcMain }) => {
      type Handler = Parameters<typeof ipcMain.handle>[1];
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get("scope:save-workspace")!;
      ipcMain.removeHandler("scope:save-workspace");
      ipcMain.handle("scope:save-workspace", async (event, workspace) => {
        if (workspace.tabs.some((tab: { hidden?: boolean }) => tab.hidden)) {
          ipcMain.removeHandler("scope:save-workspace");
          ipcMain.handle("scope:save-workspace", original);
          throw new Error("Synthetic close-state write failure");
        }
        return original(event, workspace);
      });
    });
    await page.getByRole("button", { name: "Close Saved tool", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Could not save this tab. Try again." })
      .waitFor();
    await page.getByRole("tab", { name: "Saved tool", selected: true }).waitFor();
    expect((await page.evaluate(() => window.scope.workspace()))?.tabs[0].hidden).not.toBe(true);
    await page.getByRole("button", { name: "Close Saved tool", exact: true }).click();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect((await page.evaluate(() => window.scope.workspace()))?.tabs[0].hidden).toBe(true);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
