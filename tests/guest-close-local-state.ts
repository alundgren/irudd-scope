import { guestDrawerTab } from "./guest-controls-fixture.ts";
import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";

export async function guestCloseLocalState(page: Page, app: ElectronApplication, guestId: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill("prompts");
  await page.getByRole("button", { name: "Prompts", exact: true }).click();
  const divider = page.getByRole("separator", { name: "Editor and combined prompt divider" });
  await divider.focus();
  await page.keyboard.press("Home");
  const localId = (await page
    .getByRole("tab", { name: "Prompts", exact: true })
    .getAttribute("id"))!.slice(4);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.scope.workspace()))?.tabs.find(
          (tab) => tab.id === localId,
        )?.state.data.divider,
    )
    .toBe(0.67);
  const guest = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
    (tab) => tab.id === guestId,
  )!;
  // Pause renderer timers so autosave cannot conceal a missing local write. Explicit flushes still run.
  const time = Date.now();
  await page.clock.install({ time });
  await page.reload();
  await divider.waitFor();
  await page.clock.pauseAt(time + 10000);
  await app.evaluate(({ ipcMain }, localId) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const saveChannel = "scope:save-workspace";
    const closeChannel = "scope:defer-guest-tab";
    const save = handlers.get(saveChannel)!;
    const close = handlers.get(closeChannel)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = {
      acknowledged: false,
      writes: 0,
      closed: false,
      closingDivider: undefined as unknown,
      release,
      restore: () => {
        ipcMain.removeHandler(saveChannel);
        ipcMain.handle(saveChannel, save);
        ipcMain.removeHandler(closeChannel);
        ipcMain.handle(closeChannel, close);
      },
    };
    (globalThis as unknown as { localCloseGate: typeof state }).localCloseGate = state;
    ipcMain.removeHandler(saveChannel);
    ipcMain.handle(saveChannel, async (event, ...args: unknown[]) => {
      state.writes++;
      const first = state.writes === 1;
      const result = await save(event, ...args);
      if (first) {
        state.acknowledged = true;
        await gate;
      }
      return result;
    });
    ipcMain.removeHandler(closeChannel);
    ipcMain.handle(closeChannel, async (event, ...args: unknown[]) => {
      const input = args[0] as {
        workspace: { tabs: { id: string; state: { data: { divider?: number } } }[] };
      };
      state.closingDivider = input.workspace.tabs.find(
        (tab) => tab.id === localId,
      )?.state.data.divider;
      const result = await close(event, ...args);
      state.closed = true;
      return result;
    });
  }, localId);
  const select = async (title: string) => {
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click({ force: true });
    await page.getByLabel("Search tabs", { exact: true }).fill(title);
    await page.getByRole("button", { name: title, exact: true }).click({ force: true });
  };
  try {
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click({ force: true });
    await page.getByLabel("Search tabs", { exact: true }).fill(guest.title);
    await guestDrawerTab(page, guest.title).click({ force: true });
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { localCloseGate: { acknowledged: boolean } }).localCloseGate
              .acknowledged,
        ),
      )
      .toBe(true);
    await page
      .locator(".artifact-tab.selected")
      .getByRole("button", { name: /^Close / })
      .click({ force: true });
    await select("Prompts prompts");
    await divider.focus();
    await page.keyboard.press("End");
    expect(await divider.getAttribute("aria-valuenow")).toBe("85");
    await app.evaluate(() =>
      (
        globalThis as unknown as { localCloseGate: { release: () => void } }
      ).localCloseGate.release(),
    );
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { localCloseGate: { closed: boolean } }).localCloseGate
              .closed,
        ),
      )
      .toBe(true);
    expect(
      await app.evaluate(() => {
        const { writes, closingDivider } = (
          globalThis as unknown as { localCloseGate: { writes: number; closingDivider: unknown } }
        ).localCloseGate;
        return { writes, closingDivider };
      }),
    ).toEqual({ writes: 1, closingDivider: 0.85 });
    // The close contains the new local state, but its desktop-only write has not stored that state.
    const stored = (await page.evaluate(() => window.scope.workspace()))!;
    expect(stored.tabs.find((tab) => tab.id === localId)?.state.data.divider).toBe(0.67);
    expect(stored.tabs.find((tab) => tab.id === guestId)?.hidden).toBe(true);
    return localId;
  } finally {
    await app.evaluate(() => {
      const state = (
        globalThis as unknown as { localCloseGate: { release: () => void; restore: () => void } }
      ).localCloseGate;
      state.release();
      state.restore();
    });
    await page.clock.resume();
  }
}
