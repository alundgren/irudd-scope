import { expect, test } from "vite-plus/test";
import type { ElectronApplication } from "@playwright/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

async function holdOpen(application: ElectronApplication, phase: "before" | "after" | "fail") {
  await application.evaluate(({ ipcMain }, phase) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers.get("scope:open-tab")!;
    const state = globalThis as typeof globalThis & {
      openGate: { started: boolean; finished: boolean; release: () => void };
    };
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    state.openGate = { started: false, finished: false, release };
    ipcMain.removeHandler("scope:open-tab");
    ipcMain.handle("scope:open-tab", async (event, input) => {
      ipcMain.removeHandler("scope:open-tab");
      ipcMain.handle("scope:open-tab", original);
      const result = phase === "after" ? await original(event, input) : undefined;
      state.openGate.started = true;
      await gate;
      try {
        if (phase === "fail") throw new Error("Synthetic storage failure");
        return phase === "after" ? result : await original(event, input);
      } finally {
        state.openGate.finished = true;
      }
    });
  }, phase);
  return {
    started: () =>
      application.evaluate(
        () =>
          (globalThis as typeof globalThis & { openGate: { started: boolean } }).openGate.started,
      ),
    finished: () =>
      application.evaluate(
        () =>
          (globalThis as typeof globalThis & { openGate: { finished: boolean } }).openGate.finished,
      ),
    release: () =>
      application.evaluate(() =>
        (
          globalThis as typeof globalThis & { openGate: { release: () => void } }
        ).openGate.release(),
      ),
  };
}

test.for(["before", "after"] as const)(
  "deletion and recreation while an open waits %s its real IPC handler cannot restore the old tab",
  async (phase) => {
    const f = await desktopFixture();
    const application = await f.launch();
    const gate = await holdOpen(application, phase);
    try {
      const page = await application.firstWindow();
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      const client = await f.connect();
      const metadata = {
        title: "Original publication",
        kind: "text",
        mediaType: "text/plain",
        fileName: "note.txt",
        expectedRevision: 0,
      };
      const original = await client.publish("open-race", metadata, Buffer.from("Original bytes"));
      await expect.poll(gate.started).toBe(true);
      await page.getByRole("button", { name: "Create diagram", exact: true }).click();
      await client.delete(original.id);
      const recreated = await client.publish(
        original.id,
        { ...metadata, title: "Replacement publication" },
        Buffer.from("Replacement bytes"),
      );
      expect(recreated.revision).toBeGreaterThan(original.revision);
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.scope.artifactLibrary()).artifacts[0]?.revision),
        )
        .toBe(recreated.revision);
      await gate.release();
      await expect.poll(gate.finished).toBe(true);
      expect((await page.evaluate(() => window.scope.workspace()))?.tabs).toEqual([]);
      expect(await page.getByRole("tab").count()).toBe(0);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("tab", { name: "Replacement publication", exact: true }).waitFor();
      await page.getByText("Replacement bytes", { exact: true }).waitFor();
      expect(await page.getByRole("tab").count()).toBe(1);
      await page.keyboard.press("ControlOrMeta+w");
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
      expect(await client.list()).toEqual([]);
    } finally {
      await gate.release().catch(() => {});
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.for(["before", "fail"] as const)(
  "a pending open handles %s without hiding unrelated failures",
  async (phase) => {
    const f = await desktopFixture();
    const application = await f.launch();
    const gate = await holdOpen(application, phase);
    try {
      const page = await application.firstWindow();
      const client = await f.connect();
      await client.publish(
        "pending",
        {
          title: "Pending publication",
          kind: "text",
          mediaType: "text/plain",
          fileName: "note.txt",
          expectedRevision: 0,
        },
        Buffer.from("Pending bytes"),
      );
      await expect.poll(gate.started).toBe(true);
      if (phase === "before") await client.delete("pending");
      await gate.release();
      await expect.poll(gate.finished).toBe(true);
      if (phase === "fail") {
        await page.getByRole("alert").filter({ hasText: "Synthetic storage failure" }).waitFor();
        expect(await client.list()).toHaveLength(1);
      } else {
        expect(await page.getByRole("alert").allTextContents()).toEqual([]);
        expect((await page.evaluate(() => window.scope.workspace()))?.tabs).toEqual([]);
        expect(await client.list()).toEqual([]);
      }
    } finally {
      await gate.release().catch(() => {});
      await application.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("a replacement still opens when the previous tab's close notification arrives last", async () => {
  const f = await desktopFixture();
  const application = await f.launch();
  try {
    const page = await application.firstWindow();
    const client = await f.connect();
    const metadata = {
      title: "Original publication",
      kind: "text",
      mediaType: "text/plain",
      fileName: "note.txt",
      expectedRevision: 0,
    };
    await client.publish("reordered", metadata, Buffer.from("Original bytes"));
    await page.getByRole("tab", { name: metadata.title, exact: true }).waitFor();
    const original = (await page.evaluate(() => window.scope.workspace()))!.tabs[0];
    await application.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      const held: unknown[][] = [];
      contents.send = (channel, ...args) => {
        if (channel === "scope:tabs-closed") held.push(args);
        else send(channel, ...args);
      };
      (globalThis as typeof globalThis & { releaseClosed: () => void }).releaseClosed = () => {
        contents.send = send;
        for (const args of held) send("scope:tabs-closed", ...args);
      };
    });
    await client.delete("reordered");
    await client.publish(
      "reordered",
      { ...metadata, title: "Replacement publication" },
      Buffer.from("Replacement bytes"),
    );
    await page.getByRole("tab", { name: "Replacement publication", exact: true }).waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await application.evaluate(() =>
      (globalThis as typeof globalThis & { releaseClosed: () => void }).releaseClosed(),
    );
    await expect
      .poll(async () => {
        const tabs = (await page.evaluate(() => window.scope.workspace()))!.tabs;
        return tabs.length === 1 && tabs[0].id !== original.id;
      })
      .toBe(true);
    await page.getByText("Replacement bytes", { exact: true }).waitFor();
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  } finally {
    await application.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
