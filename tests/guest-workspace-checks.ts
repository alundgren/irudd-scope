import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { guestResponseFixture } from "./guest-response-fixture.ts";

export async function guestWorkspaceChecks({
  pageA,
  pageB,
  right,
  settingsDirectory,
  guestId,
  responses,
  capture,
}: {
  pageA: Page;
  pageB: Page;
  right: ElectronApplication;
  settingsDirectory: string;
  guestId: string;
  responses: Awaited<ReturnType<typeof guestResponseFixture>>;
  capture: (name: string) => Promise<void>;
}) {
  const ownerWorkspace = await pageA.evaluate(() => window.scope.workspace());
  const ownerRetention = await pageA.evaluate(() => window.scope.retainedTabs());
  const pane = pageB.locator(`#pane-${guestId}`);
  const frame = pane.locator("iframe").contentFrame();
  const tab = pageB.locator(`#tab-${guestId}`);
  // A guest can sit before a local tab, and later catalog updates must leave it there.
  await tab.focus();
  for (let i = 0; i < 3; i++) await pageB.keyboard.press("Alt+ArrowLeft");
  await expect
    .poll(async () => {
      const workspace = (await pageB.evaluate(() => window.scope.workspace()))!;
      return workspace.tabs.filter((tab) => !tab.hidden)[0]?.id;
    })
    .toBe(guestId);
  await frame.locator("body").evaluate(() => window.scrollTo(0, 480));
  await expect
    .poll(
      async () =>
        (await pageB.evaluate(() => window.scope.workspace()))?.tabs.find(
          (tab) => tab.id === guestId,
        )?.state.data.fileScroll,
    )
    .toEqual({ x: 0, y: 480 });
  await expect
    .poll(
      async () =>
        (await pageB.evaluate(() => window.scope.workspace()))?.tabs.find(
          (tab) => tab.id === guestId,
        )?.guestReadRevision,
    )
    .toBe(1);

  responses.offline(true);
  await expect
    .poll(async () => (await pageB.evaluate(() => window.scope.guestCatalog())).available.length, {
      timeout: 20000,
    })
    .toBe(0);
  await pane.getByText(/Source Scope is unavailable/).waitFor();
  expect(await pane.locator(".guest-view").isVisible()).toBe(false);
  expect(await pane.locator(".guest-view").getAttribute("inert")).not.toBeNull();
  await capture("workspace-offline-light.png");
  responses.offline(false);
  const peer = (await pageB.evaluate(() => window.scope.transferDevices())).peers[0]!.id;
  await pageB.evaluate((id) => window.scope.retryGuest(id), peer);
  await expect
    .poll(
      async () =>
        (await pageB.evaluate(() => window.scope.guestCatalog())).available.includes(guestId),
      { timeout: 30000 },
    )
    .toBe(true);
  expect(await frame.getByLabel("Local draft").inputValue()).toBe(
    "Receiver navigation remains local",
  );
  await frame.getByRole("button", { name: "Clicked" }).waitFor();
  await expect.poll(() => frame.locator("body").evaluate(() => window.scrollY)).toBe(480);

  responses.denyAccess(true);
  await pageB.evaluate((id) => window.scope.retryGuest(id), peer);
  await expect
    .poll(async () => (await pageB.evaluate(() => window.scope.guestStatus())).peers[0]?.state, {
      timeout: 30000,
    })
    .toBe("access-denied");
  await pane.getByText(/Source Scope rejected guest access/).waitFor();
  expect(await pane.locator(".guest-view").isVisible()).toBe(false);
  await capture("workspace-access-denied-light.png");
  responses.denyAccess(false);
  await pageB.evaluate((id) => window.scope.retryGuest(id), peer);
  await expect
    .poll(
      async () =>
        (await pageB.evaluate(() => window.scope.guestCatalog())).available.includes(guestId),
      { timeout: 30000 },
    )
    .toBe(true);
  expect(await frame.getByLabel("Local draft").inputValue()).toBe(
    "Receiver navigation remains local",
  );

  // Reject real SQLite layout writes, then exercise both tab-close and quit recovery.
  const database = new DatabaseSync(join(settingsDirectory, "desktop.db"));
  try {
    database.exec(
      "CREATE TRIGGER reject_guest_workspace BEFORE UPDATE ON preferences WHEN NEW.name = 'workspace_layout' BEGIN SELECT RAISE(ABORT, 'Synthetic blocked workspace write'); END",
    );
    await tab.focus();
    await pageB.keyboard.press("Alt+ArrowRight");
    await pageB.getByText("Could not save open tabs.", { exact: false }).waitFor();
    await pageB
      .locator(".artifact-tab.selected")
      .getByRole("button", { name: "Close Same title", exact: true })
      .click();
    await pageB.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
    expect(await tab.isVisible()).toBe(true);
    await capture("workspace-save-blocked-light.png");
    await right.evaluate(({ app, dialog }) => {
      const state = globalThis as unknown as { guestQuitButtons?: string[] };
      dialog.showMessageBox = async (windowOrOptions, options?: Electron.MessageBoxOptions) => {
        state.guestQuitButtons = (
          options ?? (windowOrOptions as Electron.MessageBoxOptions)
        ).buttons;
        return { response: 0, checkboxChecked: false };
      };
      app.quit();
    });
    await expect
      .poll(() =>
        right.evaluate(
          () => (globalThis as unknown as { guestQuitButtons?: string[] }).guestQuitButtons,
        ),
      )
      .toEqual(["Keep open", "Quit without saving"]);
    expect(await tab.isVisible()).toBe(true);
  } finally {
    database.exec("DROP TRIGGER IF EXISTS reject_guest_workspace");
    database.close();
  }
  await pageB
    .getByRole("alert")
    .filter({ hasText: "Could not save open tabs." })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await pageB.getByText("Could not save open tabs.", { exact: false }).waitFor({ state: "hidden" });
  await pageB.getByRole("button", { name: "Dismiss error", exact: true }).click();
  // Restore the interleaved order after the failed save; the real quit will flush it.
  await tab.focus();
  await pageB.keyboard.press("Alt+ArrowLeft");
  expect(await pageA.evaluate(() => window.scope.workspace())).toEqual(ownerWorkspace);
  const after = await pageA.evaluate(() => window.scope.retainedTabs());
  expect(after.map(({ tab, permanent, trashedAt }) => ({ tab, permanent, trashedAt }))).toEqual(
    ownerRetention.map(({ tab, permanent, trashedAt }) => ({ tab, permanent, trashedAt })),
  );
}

export async function guestCloseFailureChecks(
  page: Page,
  settingsDirectory: string,
  id: string,
  app: ElectronApplication,
) {
  const database = new DatabaseSync(join(settingsDirectory, "desktop.db"));
  const snapshot = () => ({
    guest: database.prepare("SELECT tab FROM guest_tabs WHERE id = ?").get(id),
    layout: database
      .prepare("SELECT document FROM preferences WHERE name = 'workspace_layout'")
      .get(),
  });
  const tab = page.locator(`#tab-${id}`);
  const close = () =>
    page
      .locator(".artifact-tab.selected")
      .getByRole("button", { name: /^Close / })
      .click();
  const reject = () =>
    database.exec(`CREATE TRIGGER reject_guest_close BEFORE UPDATE ON preferences
    WHEN NEW.name = 'workspace_layout'
      AND EXISTS (SELECT 1 FROM guest_tabs WHERE id = '${id}' AND json_extract(tab, '$.hidden') = 1)
    BEGIN SELECT RAISE(ABORT, 'Synthetic layout failure after guest visibility write'); END`);
  const rejectSelection = () =>
    database.exec(`CREATE TRIGGER reject_guest_close BEFORE UPDATE ON preferences
    WHEN NEW.name = 'workspace_layout'
      AND json_extract(NEW.document, '$.selected') IS NOT json_extract(OLD.document, '$.selected')
    BEGIN SELECT RAISE(ABORT, 'Synthetic selection write failure'); END`);
  try {
    // Flushes of the visible workspace can succeed; only the subsequent close layout fails.
    reject();
    const before = snapshot();
    await expect(page.evaluate((id) => window.scope.closeTab(id), id)).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(await tab.isVisible()).toBe(true);
    await close();
    await page.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
    expect(snapshot()).toEqual(before);
    expect(await tab.isVisible()).toBe(true);
    database.exec("DROP TRIGGER reject_guest_close");
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
    // The old pre-hide/order write succeeds under this trigger; only changing selection fails.
    rejectSelection();
    const selected = snapshot();
    await close();
    await page.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
    expect(snapshot()).toEqual(selected);
    expect(await tab.getAttribute("aria-selected")).toBe("true");
    expect(await page.getByText("Could not save open tabs.", { exact: false }).count()).toBe(0);
    database.exec("DROP TRIGGER reject_guest_close");
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
    const local = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.type === "file",
    )!;
    database.exec(
      "CREATE TRIGGER reject_local_order BEFORE UPDATE ON preferences WHEN NEW.name = 'workspace_layout' BEGIN SELECT RAISE(ABORT, 'Synthetic local order failure'); END",
    );
    try {
      // A committed local close still reports success and delivers its notifications.
      await page.evaluate((id) => window.scope.setTabHidden(id, true), local.id);
      expect(
        (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
          (tab) => tab.id === local.id,
        )?.hidden,
      ).toBe(true);
      await page.evaluate((id) => window.scope.setTabHidden(id, false), local.id);
    } finally {
      database.exec("DROP TRIGGER reject_local_order");
    }
    // Retry the ordinary close and reopen paths, then leave a rejected close for the real quit.
    await close();
    await tab.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    const saved = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.id === id,
    )!;
    await page.getByLabel("Search tabs", { exact: true }).fill(saved.title);
    await page.getByRole("button", { name: saved.title + " guest", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.scope.workspace()))?.selected)
      .toBe(id);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.scope.workspace()))?.tabs.find((tab) => tab.id === id)
            ?.hidden,
      )
      .toBe(false);
    await guestCloseOrderingChecks(page, app, id, rejectSelection, () => {
      database.exec("DROP TRIGGER reject_guest_close");
    });
    await tab.focus();
    const tabCount = (await page.evaluate(() => window.scope.workspace()))!.tabs.length;
    for (let i = 0; i < tabCount; i++) await page.keyboard.press("Alt+ArrowLeft");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.scope.workspace()))?.tabs.filter(
            (tab) => !tab.hidden,
          )[0]?.id,
      )
      .toBe(id);
    rejectSelection();
    const reopened = snapshot();
    await close();
    await page.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
    expect(snapshot()).toEqual(reopened);
    expect(await tab.isVisible()).toBe(true);
    await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
    // Keep the trigger through actual quit/restart: a clean flush must not hide the rejected tab.
  } finally {
    database.close();
  }
}

async function guestCloseOrderingChecks(
  page: Page,
  app: ElectronApplication,
  id: string,
  rejectSelection: () => void,
  allowSelection: () => void,
) {
  const workspace = (await page.evaluate(() => window.scope.workspace()))!;
  const other = workspace.tabs.find((tab) => tab.type === "guest" && tab.id !== id && !tab.hidden)!;
  const title = workspace.tabs.find((tab) => tab.id === id)!.title;
  const select = async (title: string) => {
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    await page.getByLabel("Search tabs", { exact: true }).fill(title);
    await page.getByRole("button", { name: title + " guest", exact: true }).click();
  };
  for (const mode of ["select-other", "reopen", "reopen-failed"] as const) {
    await app.evaluate(({ ipcMain }) => {
      const channel = "scope:defer-guest-tab";
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers;
      const original = handlers.get(channel)!;
      if (!original) throw new Error("Missing guest close IPC handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = {
        started: false,
        release,
        restore: () => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
        },
      };
      (globalThis as unknown as { guestCloseGate: typeof state }).guestCloseGate = state;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        state.started = true;
        await gate;
        return original(event, ...args);
      });
    });
    if (mode === "reopen-failed") rejectSelection();
    try {
      await page
        .locator(".artifact-tab.selected")
        .getByRole("button", { name: /^Close / })
        .click();
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { guestCloseGate: { started: boolean } }).guestCloseGate
                .started,
          ),
        )
        .toBe(true);
      // Selecting a guest queues an immediate workspace save while the close is still pending.
      await select(other.title);
      if (mode !== "select-other") await select(title);
      await app.evaluate(() =>
        (
          globalThis as unknown as { guestCloseGate: { release: () => void } }
        ).guestCloseGate.release(),
      );
      if (mode === "reopen-failed") {
        await page.getByText("Could not save this tab. Try again.", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Dismiss error", exact: true }).click();
      }
      await expect
        .poll(async () => {
          const saved = (await page.evaluate(() => window.scope.workspace()))!;
          return {
            hidden: saved.tabs.find((tab) => tab.id === id)?.hidden,
            selected: saved.selected,
          };
        })
        .toEqual({
          hidden: mode === "select-other",
          selected: mode === "select-other" ? other.id : id,
        });
      expect(
        await page
          .locator(`#tab-${mode === "select-other" ? other.id : id}`)
          .getAttribute("aria-selected"),
      ).toBe("true");
      if (mode === "select-other") {
        await select(title);
        await expect
          .poll(async () => (await page.evaluate(() => window.scope.workspace()))?.selected)
          .toBe(id);
      }
    } finally {
      if (mode === "reopen-failed") allowSelection();
      await app.evaluate(() => {
        const state = (
          globalThis as unknown as { guestCloseGate: { release: () => void; restore: () => void } }
        ).guestCloseGate;
        state.release();
        state.restore();
      });
    }
  }
}
