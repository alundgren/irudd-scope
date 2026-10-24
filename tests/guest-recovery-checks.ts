import { expect } from "vite-plus/test";
import type { ElectronApplication, Page } from "@playwright/test";
import type { Artifact } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Delay real IPC replies without replacing the storage implementation or its validation.
async function gate(app: ElectronApplication, channel: string, afterWrite = false) {
  await app.evaluate(
    ({ ipcMain }, { channel, afterWrite }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
      const original = (
        ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
      )._invokeHandlers.get(channel)!;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const state = {
        entered: false,
        release,
        restore: () => {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, original);
        },
      };
      (globalThis as unknown as { recoveryGate: typeof state }).recoveryGate = state;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        const value = afterWrite ? await original(event, ...args) : undefined;
        state.entered = true;
        await wait;
        return afterWrite ? value : original(event, ...args);
      });
    },
    { channel, afterWrite },
  );
  return {
    entered: () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { recoveryGate: { entered: boolean } }).recoveryGate.entered,
      ),
    release: () =>
      app.evaluate(() =>
        (globalThis as unknown as { recoveryGate: { release: () => void } }).recoveryGate.release(),
      ),
    restore: () =>
      app.evaluate(() => {
        const state = (
          globalThis as unknown as { recoveryGate: { release: () => void; restore: () => void } }
        ).recoveryGate;
        state.release();
        state.restore();
      }),
  };
}
async function startFlush(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const channel = "scope:close-ready";
    const original = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers.get(channel)!;
    const state = {
      result: undefined as boolean | undefined,
      restore: () => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
      },
    };
    (globalThis as unknown as { recoveryFlush: typeof state }).recoveryFlush = state;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, result: boolean) => {
      state.result = result;
    });
    BrowserWindow.getAllWindows()[0].webContents.send("scope:before-close");
  });
  return async () => {
    try {
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { recoveryFlush: { result?: boolean } }).recoveryFlush
                .result,
          ),
        )
        .toBe(true);
    } finally {
      await app.evaluate(() =>
        (
          globalThis as unknown as { recoveryFlush: { restore: () => void } }
        ).recoveryFlush.restore(),
      );
    }
  };
}
export async function guestRecoveryChecks({
  page,
  app,
  client,
  guestId,
  settingsDirectory,
  html,
  capture,
}: {
  page: Page;
  app: ElectronApplication;
  client: ScopeClient;
  guestId: string;
  settingsDirectory: string;
  html: string;
  capture: (name: string) => Promise<void>;
}) {
  const pane = page.locator(`#pane-${guestId}`);
  const notes = () => pane.locator("iframe").contentFrame().locator("#notes");
  const read = () => page.evaluate((id) => window.scope.guestRecovery(id), guestId);
  let artifact = await client.get("mutation-document");
  async function publish(kind: "html" | "text") {
    artifact = await client.publish(
      artifact.id,
      {
        name: artifact.name,
        title: artifact.title,
        kind,
        mediaType: kind === "html" ? "text/html" : "text/plain",
        fileName: kind === "html" ? "mutation.html" : "mutation.txt",
        expectedRevision: artifact.revision,
      },
      Buffer.from(kind === "html" ? html : "Owner replaced this document with ordinary text."),
    );
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.scope.guestCatalog())).records.find(
            (record) => record.tab.id === guestId,
          )?.source.artifact?.revision,
      )
      .toBe(artifact.revision);
    if (kind === "html") await notes().waitFor();
    else
      await pane
        .getByText("Owner replaced this document with ordinary text.", { exact: true })
        .waitFor();
  }
  await page.evaluate(
    ({ guestId, revision }) => window.scope.discardGuestInput(guestId, "html", revision),
    { guestId, revision: artifact.revision },
  );
  const delayedRead = await gate(app, "scope:guest-recovery");
  const time = Date.now();
  await page.clock.install({ time });
  try {
    await page.reload();
    await notes().waitFor();
    await page.clock.pauseAt(time + 10000);
    await expect.poll(delayedRead.entered).toBe(true);
    await notes().fill("a");
    const finished = await startFlush(app);
    await page.clock.runFor(1);
    await notes().fill("ab");
    await delayedRead.release();
    await finished();
    await notes().fill("a");
    await (
      await startFlush(app)
    )();
    expect(
      (await read()).inputs
        .find((input) => input.revision === artifact.revision)
        ?.fields.find((field) => field.key === "id:notes")?.value,
    ).toBe("a");
  } finally {
    await delayedRead.restore();
    await page.clock.resume();
  }
  const overLimit = "x".repeat(8193);
  const oldRevision = artifact.revision;
  await notes().fill(overLimit);
  await pane.getByText(/This field exceeds recovery limits/).waitFor();
  await publish("html");
  await pane.getByRole("button", { name: "Copy unsaved input", exact: true }).click();
  await expect
    .poll(async () =>
      (await app.evaluate(({ clipboard }) => clipboard.readText())).includes(overLimit),
    )
    .toBe(true);
  expect(await notes().inputValue()).toBe("");
  await capture("mutations-r1-unsaved-light-laptop.png");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
  await capture("mutations-r1-unsaved-light-narrow.png");
  async function appearance(value: "light" | "dark") {
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Search settings").fill("appearance");
    await page.getByLabel("Appearance", { exact: true }).selectOption(value);
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(value);
  }
  await appearance("dark");
  await capture("mutations-r1-unsaved-dark-narrow.png");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
  await capture("mutations-r1-unsaved-dark-laptop.png");
  await pane.getByRole("button", { name: "Discard unsaved input", exact: true }).click();
  await expect
    .poll(async () => (await read()).inputs.some((input) => input.revision === oldRevision))
    .toBe(false);
  await (
    await startFlush(app)
  )();
  const db = new DatabaseSync(join(settingsDirectory, "desktop.db"));
  const failingRevision = artifact.revision;
  const delayedWrite = await gate(app, "scope:save-guest-input", true);
  try {
    db.exec(
      "CREATE TRIGGER reject_revision_recovery BEFORE INSERT ON guest_recovery BEGIN SELECT RAISE(ABORT, 'Synthetic recovery failure'); END",
    );
    await notes().fill("Latest working input across HTML to text");
    await pane
      .getByText("Could not save form input. Keep Scope open and retry.", { exact: true })
      .waitFor();
    await publish("text");
    await pane.getByRole("button", { name: "Copy unsaved input", exact: true }).click();
    await expect
      .poll(async () =>
        (await app.evaluate(({ clipboard }) => clipboard.readText())).includes(
          "Latest working input across HTML to text",
        ),
      )
      .toBe(true);
    db.exec("DROP TRIGGER reject_revision_recovery");
    await pane.getByRole("button", { name: "Retry form save", exact: true }).click();
    await expect.poll(delayedWrite.entered).toBe(true);
    await delayedWrite.release();
    await pane.getByRole("button", { name: "Copy saved input", exact: true }).click();
    expect(
      (await read()).inputs.find((input) => input.revision === failingRevision)?.fields[0].value,
    ).toBe("Latest working input across HTML to text");
    await (
      await startFlush(app)
    )();
    expect(
      await pane.getByRole("button", { name: "Restore saved fields", exact: true }).count(),
    ).toBe(0);
    await capture("mutations-r1-text-recovery-dark-laptop.png");
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_revision_recovery");
    db.close();
    await delayedWrite.restore();
  }
  await publish("html");
  const discardGate = await gate(app, "scope:save-guest-input", true);
  try {
    await notes().fill("A write being acknowledged when discarded");
    await expect.poll(discardGate.entered).toBe(true);
    // Discard queues behind the pending write and must not require an invalid draft to save first.
    await pane.getByRole("button", { name: "Discard unsaved input", exact: true }).click();
    await discardGate.release();
    await expect
      .poll(async () => (await read()).inputs.some((input) => input.revision === artifact.revision))
      .toBe(false);
    await (
      await startFlush(app)
    )();
    expect((await read()).inputs.some((input) => input.revision === artifact.revision)).toBe(false);
  } finally {
    await discardGate.restore();
  }
  await appearance("light");
  return artifact as Artifact;
}
