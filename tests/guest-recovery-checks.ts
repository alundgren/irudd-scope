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
      const host = globalThis as unknown as { recoveryGates?: Record<string, typeof state> };
      (host.recoveryGates ??= {})[channel] = state;
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
        (_electron, channel) =>
          (globalThis as unknown as { recoveryGates: Record<string, { entered: boolean }> })
            .recoveryGates[channel].entered,
        channel,
      ),
    release: () =>
      app.evaluate(
        (_electron, channel) =>
          (
            globalThis as unknown as { recoveryGates: Record<string, { release: () => void }> }
          ).recoveryGates[channel].release(),
        channel,
      ),
    restore: () =>
      app.evaluate((_electron, channel) => {
        const state = (
          globalThis as unknown as {
            recoveryGates: Record<string, { release: () => void; restore: () => void }>;
          }
        ).recoveryGates[channel];
        state.release();
        state.restore();
      }, channel),
  };
}
async function startFlush(app: ElectronApplication, expected = true) {
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
        .toBe(expected);
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
  db.exec("PRAGMA busy_timeout = 5000");
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

export async function guestReadFailureChecks({
  page,
  app,
  guestId,
  capture,
}: {
  page: Page;
  app: ElectronApplication;
  guestId: string;
  capture: (name: string) => Promise<void>;
}) {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const channel = "scope:guest-recovery";
    const original = (
      ipcMain as unknown as { _invokeHandlers: Map<string, Handler> }
    )._invokeHandlers.get(channel)!;
    (globalThis as unknown as { restoreRecoveryRead: () => void }).restoreRecoveryRead = () => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
    };
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, () => {
      throw new Error("Synthetic initial recovery read failure");
    });
  });
  try {
    await page.reload();
    const pane = page.locator(`#pane-${guestId}`);
    const notes = pane.locator("iframe").contentFrame().locator("#notes");
    const retry = pane.getByRole("button", { name: "Retry reading input", exact: true });
    await retry.waitFor();
    await (
      await startFlush(app, false)
    )();
    await app.evaluate(() =>
      (globalThis as unknown as { restoreRecoveryRead: () => void }).restoreRecoveryRead(),
    );
    await notes.fill("Recovered after an initial read failure");
    const frame = pane.locator("iframe").contentFrame();
    await frame.locator("#choice").selectOption("b");
    await frame.locator("#agreed").check();
    await frame.locator("#first").check();
    expect(await retry.isVisible(), "Read retry remains available after supported input").toBe(
      true,
    );
    await capture("mutations-r2-read-light-laptop.png");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await capture("mutations-r2-read-light-narrow.png");
    await appearance(page, "dark");
    await capture("mutations-r2-read-dark-narrow.png");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820));
    await capture("mutations-r2-read-dark-laptop.png");
    const pending = await gate(app, "scope:guest-recovery");
    try {
      await retry.click();
      await expect.poll(pending.entered).toBe(true);
      expect(
        await pane.getByRole("button", { name: "Reading saved input…", exact: true }).isDisabled(),
      ).toBe(true);
      const finished = await startFlush(app);
      await pending.release();
      await finished();
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.scope.guestRecovery(id), guestId)).inputs
              .find((input) => input.kind === "html")
              ?.fields.find((field) => field.key === "id:notes")?.value,
        )
        .toBe("Recovered after an initial read failure");
    } finally {
      await pending.restore();
    }
    await appearance(page, "light");
  } catch (error) {
    console.error("Initial recovery read journey failed:", error);
    throw error;
  } finally {
    await app.evaluate(() =>
      (globalThis as unknown as { restoreRecoveryRead: () => void }).restoreRecoveryRead(),
    );
  }
}
async function appearance(page: Page, value: "light" | "dark") {
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
export async function guestTitleCleanupChecks({
  page,
  app,
  client,
  guestId,
  html,
  mode,
}: {
  page: Page;
  app: ElectronApplication;
  client: ScopeClient;
  guestId: string;
  html: string;
  mode: "discard" | "rename";
}) {
  const pane = page.locator(`#pane-${guestId}`);
  const details = pane.getByText(/Source actions ·/).locator("..");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator("summary").click();
  const title = pane.getByLabel("Source title", { exact: true });
  await title.fill("Older title draft");
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.scope.guestRecovery(id), guestId)).inputs
          .filter((input) => input.kind === "action")
          .at(-1)?.title,
    )
    .toBe("Older title draft");
  let artifact = await client.get("mutation-document");
  artifact = await client.publish(
    artifact.id,
    {
      name: artifact.name,
      title: artifact.title,
      kind: "html",
      mediaType: "text/html",
      fileName: "mutation.html",
      expectedRevision: artifact.revision,
    },
    Buffer.from(html),
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.scope.guestCatalog())).records.find(
          (record) => record.tab.id === guestId,
        )?.source.artifact?.revision,
    )
    .toBe(artifact.revision);
  await pane.getByRole("button", { name: "Review current owner source", exact: true }).click();
  await pane
    .getByText(
      `Current owner revision ${artifact.revision}. Review your retained input before saving.`,
      { exact: true },
    )
    .waitFor();
  const save = await gate(app, "scope:save-guest-input");
  const read = await gate(app, "scope:guest-recovery", true);
  try {
    const submitted = mode === "discard" ? "Discarded current title" : "Acknowledged current title";
    await title.fill(submitted);
    await expect.poll(save.entered).toBe(true);
    await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()[0].webContents.send("scope:guest-recovery-changed", id),
      guestId,
    );
    await expect.poll(read.entered).toBe(true);
    await pane
      .getByRole("button", {
        name: mode === "discard" ? "Discard title draft" : "Rename on Owner laptop",
        exact: true,
      })
      .click();
    await save.release();
    if (mode === "discard") await expect.poll(() => title.inputValue()).toBe(artifact.title);
    else await expect.poll(async () => (await client.get(artifact.id)).title).toBe(submitted);
    await read.release();
    await expect.poll(() => title.isEnabled()).toBe(true);
    await (
      await startFlush(app)
    )();
    return await client.get(artifact.id);
  } finally {
    await save.restore();
    await read.restore();
  }
}
