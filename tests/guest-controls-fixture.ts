import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";

export function guestDrawerTab(page: Page, title: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .+ · Shared by `),
  });
}

export function guestControls(page: Page) {
  return page.getByRole("dialog", { name: "Search and controls", exact: true });
}
export async function openGuestControls(page: Page, section?: "source" | "recovery") {
  const panel = guestControls(page);
  if (!(await panel.isVisible()))
    await page.getByRole("button", { name: "Search and controls", exact: true }).click();
  if (section) {
    const summary = panel.locator("summary").filter({
      hasText: section === "source" ? /Source actions ·/ : "Form input recovery",
    });
    if ((await summary.locator("..").getAttribute("open")) === null) await summary.click();
  }
  return panel;
}
export async function closeGuestControls(page: Page) {
  const panel = guestControls(page);
  if (await panel.isVisible()) {
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
  }
}

export async function guestConnectionControls(page: Page, app: ElectronApplication) {
  await openGuestControls(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Search settings").fill("other scopes");
  await page.getByText(/^Guest connection: connected\./).waitFor();
  expect(await page.getByRole("button", { name: "Retry connection", exact: true }).count()).toBe(0);
  // Hold only the displayed connection state while the real paired connection stays available.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<{ peers: { state: string }[] }>;
    const channel = "scope:guest-status";
    const original = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers.get(channel)!;
    (globalThis as unknown as { restoreGuestStatus: () => void }).restoreGuestStatus = () => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
    };
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const status = await original(event, ...args);
      return { ...status, peers: status.peers.map((peer) => ({ ...peer, state: "connecting" })) };
    });
  });
  try {
    await page.getByText(/^Guest connection: connecting\./).waitFor();
    expect(await page.getByRole("button", { name: "Retry connection", exact: true }).count()).toBe(
      0,
    );
  } finally {
    await app.evaluate(() =>
      (globalThis as unknown as { restoreGuestStatus: () => void }).restoreGuestStatus(),
    );
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
  }
}

export async function guestSearchKeyboardChecks(
  page: Page,
  app: ElectronApplication,
  guestId: string,
  draft: string,
) {
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.scope.guestRecovery(id), guestId)).inputs.find(
          (input) => input.kind === "action",
        )?.title,
    )
    .toBe(draft);
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const calls: string[] = [];
    const originals = new Map(
      ["scope:guest-prepare", "scope:guest-execute"].map((channel) => [
        channel,
        handlers.get(channel)!,
      ]),
    );
    (
      globalThis as unknown as { guestKeyboard: { calls: string[]; restore: () => void } }
    ).guestKeyboard = {
      calls,
      restore: () => {
        for (const [channel, original] of originals) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
        }
      },
    };
    for (const [channel, original] of originals) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        calls.push(channel);
        return original(event, ...args);
      });
    }
  });
  try {
    for (const expanded of [false, true]) {
      const panel = await openGuestControls(page, "source");
      const summary = panel.locator("summary").filter({ hasText: "Source actions" });
      const details = summary.locator("..");
      if (!expanded) await summary.click();
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(
        expanded,
      );
      const search = page.getByLabel("Search artifacts", { exact: true });
      await search.fill("trash");
      await search.press("Enter");
      await expect
        .poll(() => summary.evaluate((element) => document.activeElement === element))
        .toBe(true);
      expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(true);
      await search.focus();
      await search.press("ArrowDown");
      expect(await summary.evaluate((element) => document.activeElement === element)).toBe(true);
      await search.fill("source");
      await search.press("ArrowDown");
      const artifactDetails = panel.getByRole("button", { name: "Artifact details", exact: true });
      expect(await artifactDetails.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      await page.keyboard.press("ArrowDown");
      expect(await summary.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press("ArrowUp");
      expect(await artifactDetails.evaluate((element) => document.activeElement === element)).toBe(
        true,
      );
      const title = panel.getByLabel("Source title", { exact: true });
      await title.focus();
      await title.press("Home");
      await title.press("ArrowRight");
      expect(await title.evaluate((element) => (element as HTMLInputElement).selectionStart)).toBe(
        1,
      );
      await title.press("Enter");
      expect(await title.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await title.inputValue()).toBe(draft);
      // Observe delayed dispatch too: source actions flush an autosave before preparing a change.
      await page.waitForTimeout(2000);
      expect(
        await app.evaluate(
          () =>
            (globalThis as unknown as { guestKeyboard: { calls: string[] } }).guestKeyboard.calls,
        ),
      ).toEqual([]);
      expect(
        (await page.evaluate((id) => window.scope.guestRecovery(id), guestId)).pending,
      ).toBeUndefined();
      await closeGuestControls(page);
    }
    await openGuestControls(page);
    const search = page.getByLabel("Search artifacts", { exact: true });
    await search.fill("settings");
    await search.press("ArrowDown");
    expect(
      await guestControls(page)
        .getByRole("button", { name: "Settings", exact: true })
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.waitFor();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await openGuestControls(page);
    await search.fill("appearance");
    await search.press("Enter");
    await settings.getByLabel("Appearance", { exact: true }).waitFor();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await openGuestControls(page, "source");
    expect(await guestControls(page).getByLabel("Source title", { exact: true }).inputValue()).toBe(
      draft,
    );
  } finally {
    await app.evaluate(() =>
      (globalThis as unknown as { guestKeyboard: { restore: () => void } }).guestKeyboard.restore(),
    );
  }
}
