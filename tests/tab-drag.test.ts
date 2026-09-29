import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

test("dragging tabs preserves filtered order and HTML state, supports recovery, and survives restart", async () => {
  const f = await desktopFixture();
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    page.setDefaultTimeout(6000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const client = await f.connect();
    for (const title of ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"])
      await client.publish(
        title.toLowerCase(),
        {
          title,
          kind: "html",
          mediaType: "text/html",
          fileName: "notes.html",
          expectedRevision: 0,
        },
        Buffer.from("<label>Draft<input></label>"),
      );
    const order = () =>
      page.evaluate(async () => (await window.scope.workspace())?.tabs.map((tab) => tab.title));
    const picker = () => page.getByRole("button", { name: /^Tabs and Trashcan,/ });
    const drawer = () => page.locator(".tab-overflow-popup");
    const row = (title: string) =>
      drawer()
        .locator(".tab-drawer-row")
        .filter({ has: page.getByRole("button", { name: `${title} html`, exact: true }) });
    await expect.poll(order).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]);
    const html = page.frameLocator('iframe[title="Alpha"]');
    await html.getByLabel("Draft").fill("Keep my unsaved input through dragging");
    const frame = await page.locator('iframe[title="Alpha"]').elementHandle();
    await picker().click();
    for (const title of ["Bravo", "Delta"])
      await drawer()
        .getByRole("button", { name: `Keep permanently: ${title}`, exact: true })
        .click();
    expect(await page.getByRole("tab", { selected: true }).textContent()).toBe("Alpha");
    await drawer().getByRole("button", { name: "Permanent", exact: true }).click();
    // Native drops need pointer movement to deliver dragover before releasing the mouse.
    await row("Delta").dragTo(row("Bravo"), { targetPosition: { x: 80, y: 3 }, steps: 8 });
    await expect.poll(order).toEqual(["Alpha", "Delta", "Bravo", "Charlie", "Echo", "Foxtrot"]);
    await drawer().getByRole("button", { name: "All", exact: true }).click();
    const echoBounds = await row("Echo").boundingBox();
    await row("Alpha").dragTo(row("Echo"), {
      targetPosition: { x: 80, y: echoBounds!.height - 3 },
      steps: 8,
    });
    await expect.poll(order).toEqual(["Delta", "Bravo", "Charlie", "Echo", "Alpha", "Foxtrot"]);
    const charlie = drawer().getByRole("button", { name: "Charlie html", exact: true });
    await charlie.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(order).toEqual(["Delta", "Charlie", "Bravo", "Echo", "Alpha", "Foxtrot"]);
    expect(await charlie.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(order).toEqual(["Delta", "Bravo", "Charlie", "Echo", "Alpha", "Foxtrot"]);
    await page.keyboard.press("Escape");
    await page
      .getByRole("tab", { name: "Foxtrot", exact: true })
      .dragTo(page.getByRole("tab", { name: "Delta", exact: true }), {
        targetPosition: { x: 3, y: 16 },
        steps: 8,
      });
    await expect.poll(order).toEqual(["Foxtrot", "Delta", "Bravo", "Charlie", "Echo", "Alpha"]);
    expect(await frame!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await html.getByLabel("Draft").inputValue()).toBe(
      "Keep my unsaved input through dragging",
    );

    // Open the drawer during a native strip drag, then drop a permanent tab onto Trashcan.
    const deltaBounds = await page.getByRole("tab", { name: "Delta", exact: true }).boundingBox();
    const pickerBounds = await picker().boundingBox();
    await page.mouse.move(deltaBounds!.x + 30, deltaBounds!.y + 16);
    await page.mouse.down();
    await page.mouse.move(deltaBounds!.x + 40, deltaBounds!.y + 16, { steps: 3 });
    await page.mouse.move(pickerBounds!.x + 25, pickerBounds!.y + 16, { steps: 6 });
    await drawer().waitFor();
    const trashBounds = await drawer()
      .getByRole("button", { name: "Trashcan", exact: true })
      .boundingBox();
    await page.mouse.move(trashBounds!.x + 40, trashBounds!.y + 16, { steps: 10 });
    await page.mouse.up();
    await expect.poll(order).toEqual(["Foxtrot", "Bravo", "Charlie", "Echo", "Alpha"]);
    await drawer().getByRole("button", { name: "Trashcan", exact: true }).click();
    await drawer()
      .getByRole("button", { name: /Delta html Restore/ })
      .click();
    await page.getByRole("tab", { name: "Delta", selected: true }).waitFor();
    await expect.poll(order).toEqual(["Foxtrot", "Bravo", "Charlie", "Echo", "Alpha", "Delta"]);
    await page.getByRole("button", { name: "Make temporary: Delta", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Alpha", exact: true }).click();
    expect(await html.getByLabel("Draft").inputValue()).toBe(
      "Keep my unsaved input through dragging",
    );

    // Dropping outside a target and dropping foreign data must leave the saved order intact.
    await picker().click();
    await row("Bravo").dragTo(drawer().getByRole("button", { name: "All", exact: true }), {
      steps: 8,
    });
    const foreign = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.setData("application/x-scope-tab", document.querySelector('[role="tab"]')!.id.slice(4));
      return data;
    });
    await drawer()
      .getByRole("button", { name: "Trashcan", exact: true })
      .dispatchEvent("drop", { dataTransfer: foreign });
    await foreign.dispose();
    await page.keyboard.press("Escape");
    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    await expect.poll(order).toEqual(["Foxtrot", "Bravo", "Charlie", "Echo", "Alpha", "Delta"]);
    await page.getByRole("tab", { name: "Alpha", selected: true }).waitFor();
    await page.getByRole("button", { name: "Make temporary: Delta", exact: true }).waitFor();
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
