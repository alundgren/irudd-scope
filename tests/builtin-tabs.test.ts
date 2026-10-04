import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

test("built-in tabs have a fixed indicator and close through Delete, controls, and restart without entering Trashcan", async () => {
  const f = await desktopFixture();
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    const id = await page.evaluate(async () => {
      const workspace = (await window.scope.workspace())!;
      const tab = (await window.scope.openTab({
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: "memory",
        title: "Personal memory",
        state: { version: 1, data: {} },
      }))!;
      await window.scope.saveWorkspace({ ...workspace, tabs: [tab], selected: tab.id });
      return tab.id;
    });
    await page.reload();
    await page.getByRole("tab", { name: "Personal memory", selected: true }).waitFor();
    await page.getByRole("img", { name: "Built-in tab: Personal memory", exact: true }).waitFor();
    expect(
      await page
        .getByRole("button", { name: "Make temporary: Personal memory", exact: true })
        .count(),
    ).toBe(0);
    await page.getByRole("button", { name: "Search and controls", exact: true }).click();
    expect(await page.getByRole("button", { name: "Make temporary", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Move to Trashcan", exact: true }).count()).toBe(
      0,
    );
    await page.getByRole("button", { name: "Close tab", exact: true }).click();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(0);
    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(await page.getByRole("tab").count()).toBe(0);
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    const drawer = page.locator(".tab-overflow-popup");
    await drawer.getByRole("img", { name: "Built-in tab: Personal memory", exact: true }).waitFor();
    await drawer.locator("[data-tab-result]").filter({ hasText: "Personal memory" }).click();
    expect(await page.getByRole("tab", { name: "Personal memory" }).getAttribute("id")).toBe(
      `tab-${id}`,
    );
    await page.getByRole("tab", { name: "Personal memory" }).focus();
    await page.keyboard.press("Delete");
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    await drawer.getByRole("button", { name: "Trashcan", exact: true }).click();
    await page.getByText("Trashcan is empty.", { exact: true }).waitFor();
    expect((await page.evaluate(() => window.scope.retainedTabs()))[0]).toMatchObject({
      tab: { id },
      permanent: true,
      trashedAt: null,
    });
    await page.keyboard.press("Escape");
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
