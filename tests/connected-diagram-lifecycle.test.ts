import { expect, test } from "vite-plus/test";
import type { ElectronApplication } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

async function holdAgentCancellation(application: ElectronApplication) {
  await application.evaluate(({ ipcMain }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1];
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers;
    const original = handlers.get("scope:cancel-diagram-agent")!;
    const pending: Promise<unknown>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = globalThis as typeof globalThis & {
      releaseAgentCancellation: () => Promise<void>;
    };
    state.releaseAgentCancellation = async () => {
      ipcMain.removeHandler("scope:cancel-diagram-agent");
      ipcMain.handle("scope:cancel-diagram-agent", original);
      release();
      await Promise.all(pending);
    };
    ipcMain.removeHandler("scope:cancel-diagram-agent");
    ipcMain.handle("scope:cancel-diagram-agent", (event, input) => {
      const result = gate.then(() => original(event, input));
      pending.push(result);
      return result;
    });
  });
  return () =>
    application.evaluate(() =>
      (
        globalThis as typeof globalThis & { releaseAgentCancellation: () => Promise<void> }
      ).releaseAgentCancellation(),
    );
}

test.each(["trash", "delete"] as const)(
  "late view cleanup preserves the next agent after %s and reopening a diagram",
  async (action) => {
    const fixture = await desktopFixture();
    const application = await fixture.launch();
    let release: (() => Promise<void>) | undefined;
    try {
      const page = await application.firstWindow();
      page.setDefaultTimeout(6000);
      await page.getByRole("button", { name: "Search and controls" }).waitFor();
      const client = await fixture.connect();
      const operations = JSON.parse(
        await readFile(new URL("./fixtures/diagram-response.json", import.meta.url), "utf8"),
      ).operations;
      const create = () =>
        client.diagram({ action: "create", id: "reused", title: "Reused diagram", operations });
      await create();
      const firstTab = await page.evaluate(
        async () => (await window.scope.workspace())!.tabs[0].id,
      );
      await page.getByTestId("main-menu-trigger").click();
      await page.getByRole("button", { name: "Ask agent", exact: true }).click();
      const recipient = page.getByRole("combobox", { name: "Conversation recipient" });
      await recipient.selectOption("connected");
      const first = client.diagramAgent({ action: "wait", id: "reused", name: "First agent" });
      void first.catch(() => {});
      await page.getByText("First agent · Waiting for a request", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Change diagram" }).fill("An old request.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const oldRequest = await first;
      if (oldRequest.type !== "request") throw new Error("Expected a request");
      release = await holdAgentCancellation(application);
      if (action === "trash")
        await page.getByRole("button", { name: "Close Reused diagram", exact: true }).click();
      else await client.delete("reused");
      await expect.poll(() => page.getByRole("tab").count()).toBe(0);
      expect(await page.evaluate(() => window.scope.diagramAgentStatus("reused"))).toMatchObject({
        phase: "disconnected",
      });
      await expect(
        client.diagramAgent({ action: "wait", id: "reused", name: "Unavailable agent" }),
      ).rejects.toThrow("Open this diagram tab");
      if (action === "trash") {
        expect((await client.get("reused")).id).toBe("reused");
        await page.getByRole("button", { name: /^More tabs,/ }).click();
        await page.getByRole("button", { name: "Trashcan", exact: true }).click();
        await page.locator(".tab-overflow-popup [data-tab-result]").click();
      } else await create();
      await page.getByRole("tab", { name: "Reused diagram", exact: true }).waitFor();
      const nextTab = await page.evaluate(async () => (await window.scope.workspace())!.tabs[0].id);
      expect(nextTab === firstTab).toBe(action === "trash");
      if (!(await recipient.isVisible())) {
        await page.getByTestId("main-menu-trigger").click();
        await page.getByRole("button", { name: "Ask agent", exact: true }).click();
      }
      await recipient.selectOption("connected");
      await expect
        .poll(
          async () =>
            (await client.diagram({ action: "read", id: "reused" }).catch(() => null))?.type,
        )
        .toBe("snapshot");
      const next = client.diagramAgent({ action: "wait", id: "reused", name: "Next agent" });
      void next.catch(() => {});
      await page.getByText("Next agent · Waiting for a request", { exact: true }).waitFor();
      await release();
      release = undefined;
      expect(await page.evaluate(() => window.scope.diagramAgentStatus("reused"))).toMatchObject({
        phase: "waiting",
        name: "Next agent",
      });
      await expect(
        client.diagramAgent({
          action: "reply",
          id: "reused",
          requestId: oldRequest.requestId,
          token: oldRequest.token,
          snapshot: oldRequest.diagram.snapshot,
          message: "Old answer",
          operations: [],
        }),
      ).rejects.toThrow("expired");
      await page.getByRole("textbox", { name: "Change diagram" }).fill("A fresh request.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const request = await next;
      if (request.type !== "request") throw new Error("Expected the next request");
      expect(request.intent).toBe("A fresh request.");
      await client.diagramAgent({
        action: "reply",
        id: "reused",
        requestId: request.requestId,
        token: request.token,
        snapshot: request.diagram.snapshot,
        message: "Fresh answer",
        operations: [],
      });
      await page.getByText("Fresh answer", { exact: true }).waitFor();
    } finally {
      await release?.().catch(() => {});
      await application.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
  30_000,
);
