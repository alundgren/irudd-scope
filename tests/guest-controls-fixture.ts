import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";

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
