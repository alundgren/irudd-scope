import { afterEach, expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type OpenGate = {
  firstStarted: boolean;
  secondStarted: boolean;
  secondFinished: boolean;
  releaseFirst: () => void;
  releaseSecond: () => void;
  restore: () => void;
};

test.for(["before", "after"] as const)(
  "repeated initial memory opens racing with close stay hidden across restart (%s handler)",
  async (phase) => {
    const f = await desktopFixture();
    cleanup.push(() => rm(f.directory, { recursive: true, force: true }));
    let application = await f.launch();
    cleanup.push(() => application.close());
    let page = await application.firstWindow();
    await application.evaluate(({ ipcMain }, phase) => {
      type Handler = Parameters<typeof ipcMain.handle>[1];
      const original = (
        ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get("scope:open-tab")!;
      const state = globalThis as typeof globalThis & { memoryOpenGate?: OpenGate };
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const first = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const second = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const gate: OpenGate = {
        firstStarted: false,
        secondStarted: false,
        secondFinished: false,
        releaseFirst,
        releaseSecond,
        restore: () => {
          ipcMain.removeHandler("scope:open-tab");
          ipcMain.handle("scope:open-tab", original);
        },
      };
      state.memoryOpenGate = gate;
      let calls = 0;
      ipcMain.removeHandler("scope:open-tab");
      ipcMain.handle("scope:open-tab", async (event, input, revision) => {
        if (input.tab?.type !== "memory") return original(event, input, revision);
        ++calls;
        if (calls === 1) {
          gate.firstStarted = true;
          await first;
          return original(event, input, revision);
        }
        if (calls === 2) {
          const result = phase === "after" ? await original(event, input, revision) : undefined;
          gate.secondStarted = true;
          await second;
          try {
            return phase === "after" ? result : await original(event, input, revision);
          } finally {
            gate.secondFinished = true;
          }
        }
        return original(event, input, revision);
      });
    }, phase);
    const gatedApplication = application;
    cleanup.push(() =>
      gatedApplication
        .evaluate(() => {
          const gate = (globalThis as typeof globalThis & { memoryOpenGate?: OpenGate })
            .memoryOpenGate;
          gate?.releaseFirst();
          gate?.releaseSecond();
          gate?.restore();
        })
        .catch(() => {}),
    );
    await page.getByRole("button", { name: "Search and controls", exact: true }).click();
    const action = page.getByRole("button", { name: "Personal memory", exact: true });
    await action.click();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }).memoryOpenGate
              ?.firstStarted,
        ),
      )
      .toBe(true);
    await action.click();
    await application.evaluate(() =>
      (
        globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }
      ).memoryOpenGate?.releaseFirst(),
    );
    await page.getByRole("tab", { name: "Personal memory", exact: true, selected: true }).waitFor();
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }).memoryOpenGate
              ?.secondStarted,
        ),
      )
      .toBe(true);
    const id = (await page.evaluate(() => window.scope.workspace()))!.tabs.find(
      (tab) => tab.type === "memory",
    )!.id;
    await page.getByRole("button", { name: "Close Personal memory", exact: true }).click();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(
      (await page.evaluate(() => window.scope.workspace()))!.tabs.find((tab) => tab.id === id)!
        .hidden,
    ).toBe(true);
    await application.evaluate(() =>
      (
        globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }
      ).memoryOpenGate?.releaseSecond(),
    );
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            (globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }).memoryOpenGate
              ?.secondFinished,
        ),
      )
      .toBe(true);
    const retained = () =>
      page.evaluate(async () => {
        const workspace = (await window.scope.workspace())!;
        return {
          selected: workspace.selected,
          tabs: workspace.tabs
            .filter((tab) => tab.type === "memory")
            .map(({ id, hidden }) => ({ id, hidden })),
        };
      });
    await expect.poll(retained).toEqual({ selected: null, tabs: [{ id, hidden: true }] });
    expect(await page.getByRole("tab", { name: "Personal memory", exact: true }).count()).toBe(0);
    await application.evaluate(() =>
      (globalThis as typeof globalThis & { memoryOpenGate?: OpenGate }).memoryOpenGate?.restore(),
    );
    await application.close();
    application = await f.launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    expect(await retained()).toEqual({ selected: null, tabs: [{ id, hidden: true }] });
    await page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    await page
      .locator(".tab-overflow-popup [data-tab-result]")
      .filter({ hasText: "Personal memory" })
      .click();
    await page.getByRole("tab", { name: "Personal memory", exact: true, selected: true }).waitFor();
    await expect.poll(async () => (await retained()).tabs).toEqual([{ id, hidden: false }]);
  },
);
