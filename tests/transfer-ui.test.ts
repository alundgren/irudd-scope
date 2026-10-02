import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { desktopFixture } from "./desktop-fixture.ts";
import type { Artifact } from "@irudd-scope/protocol";

type TestTransfer = {
  state: string;
  cancelled: number;
  imported: number;
  copied: number;
  sent: number;
  pauseImport: boolean;
};
type TestMain = { scopeTransferUITest: TestTransfer; resumeScopeImport?: () => void };

async function installTransferResponses(app: ElectronApplication, artifact?: Artifact) {
  await app.evaluate(({ ipcMain, clipboard }, artifact) => {
    const control = {
      state: "waiting",
      cancelled: 0,
      imported: 0,
      copied: 0,
      sent: 0,
      pauseImport: false,
    };
    (globalThis as unknown as TestMain).scopeTransferUITest = control;
    const devices = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      name: "Studio Mac",
      peers: [] as { id: string; deviceId: string; name: string; createdAt: number }[],
      credentialStorage: "session",
    };
    const peer = {
      id: "22222222-2222-4222-8222-222222222222",
      deviceId: "33333333-3333-4333-8333-333333333333",
      name: "Travel Mac",
      createdAt: Date.now(),
    };
    if (artifact) devices.peers.push(peer);
    const expiresAt = Date.now() + 15 * 60_000;
    const invitation = (pairing = false) => ({
      id: "44444444-4444-4444-8444-444444444444",
      url: `scope-transfer://v1/#${Buffer.from(
        JSON.stringify({
          version: 1,
          mode: pairing ? "pair" : "tab",
          id: "44444444-4444-4444-8444-444444444444",
          pairId: peer.id,
          sourceId: devices.deviceId,
          expiresAt,
          address: "tc" + "synthetic-public-address-".repeat(6),
          mac: "A".repeat(43),
        }),
      ).toString("base64url")}`,
      expiresAt,
      state: control.state,
    });
    const handlers = {
      "transfer-devices": () => devices,
      "create-pairing": (_event: unknown, name: string) => {
        devices.name = name;
        control.state = "waiting";
        return invitation(true);
      },
      "copy-pairing-secret": () => {
        control.copied++;
        return clipboard.writeText("synthetic-pairing-secret");
      },
      "pair-scope": (_event: unknown, input: { name: string; secret: string }) => {
        if (input.secret !== "synthetic-pairing-secret")
          throw new Error("Pairing secret does not match. Retry.");
        devices.name = input.name;
        devices.peers.push(peer);
      },
      "forget-scope": () => {
        devices.peers = [];
      },
      "send-tab": () => {
        control.sent++;
        control.state = "waiting";
        return invitation();
      },
      "transfer-status": () => invitation(),
      "cancel-transfer": () => {
        control.cancelled++;
        control.state = "cancelled";
      },
      "inspect-transfer": (_event: unknown, url: string) => {
        if (!url.startsWith("scope-transfer://"))
          throw new Error("Paste the complete transfer link.");
        return {
          id: invitation().id,
          title: artifact?.title ?? "Preview only",
          kind: artifact?.kind ?? "html",
          fileName: "review.html",
          size: 1024,
          sourceName: "Travel Mac",
          expiresAt: invitation().expiresAt,
          alreadyImported: control.imported > 0,
        };
      },
      "import-transfer": async () => {
        if (control.pauseImport)
          await new Promise<void>((resolve) => {
            (globalThis as unknown as TestMain).resumeScopeImport = resolve;
          });
        control.imported++;
        return { artifact, alreadyImported: control.imported > 1 };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeHandler(`scope:${channel}`);
      ipcMain.handle(`scope:${channel}`, handler);
    }
  }, artifact);
}

async function openOtherScopes(page: Page) {
  await page.getByRole("button", { name: "Search and controls" }).click();
  await page.getByLabel("Search artifacts", { exact: true }).fill("other scopes");
  await page.getByRole("button", { name: "Other Scopes Setting" }).click();
}

async function controls(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as unknown as TestMain).scopeTransferUITest);
}

async function screenshot(page: Page, name: string) {
  if (!process.env.SCOPE_REVIEW_DIR) return;
  await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
  await page.screenshot({ animations: "disabled", path: join(process.env.SCOPE_REVIEW_DIR, name) });
}

test("Send tab leaves the current tab open when pending workspace writes fail", async () => {
  const f = await desktopFixture();
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await f.cli(
      "text",
      "Current tab stays open",
      "--id",
      "transfer-save-source",
      "--title",
      "Current review",
    );
    await page.getByText("Current tab stays open", { exact: true }).waitFor();
    const client = await f.connect();
    const artifact = (await client.list()).find((entry) => entry.id === "transfer-save-source")!;
    await installTransferResponses(app, artifact);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("scope:save-workspace");
      ipcMain.handle("scope:save-workspace", () => {
        throw new Error("Synthetic save failure");
      });
    });
    await f.cli(
      "text",
      "A background tab",
      "--id",
      "transfer-save-background",
      "--title",
      "Background review",
    );
    await page.getByRole("tab", { name: "Background review", exact: true }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Send tab", exact: true }).click();
    await page.getByRole("button", { name: "Create transfer link", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Send tab", exact: true })
      .getByText("Could not save the workspace.")
      .waitFor();
    expect((await controls(app)).sent).toBe(0);
    expect(
      await page
        .getByRole("tab", { name: "Current review", exact: true, includeHidden: true })
        .count(),
    ).toBe(1);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("scope:save-workspace");
      ipcMain.handle("scope:save-workspace", () => {});
    });
    await page.getByRole("button", { name: "Create transfer link", exact: true }).click();
    await page.getByRole("img", { name: "Transfer QR code" }).waitFor();
    expect((await controls(app)).sent).toBe(1);
    await page.getByRole("button", { name: "Cancel transfer", exact: true }).click();
    await page.getByText("Current tab stays open", { exact: true }).waitFor();
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("scope:save-workspace");
        ipcMain.handle("scope:save-workspace", () => {});
      })
      .catch(() => {});
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);

test("Other Scopes creates a public invitation, copies the secret through main, pairs, and forgets", async () => {
  const f = await desktopFixture();
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await installTransferResponses(app);
    await openOtherScopes(page);
    await page.getByText("No other Scopes paired.").waitFor();
    await page.getByRole("button", { name: "Create pairing invitation", exact: true }).click();
    await page.getByLabel("This Scope's name").fill("Studio Mac");
    await page.getByRole("button", { name: "Create pairing link", exact: true }).click();
    await page.getByRole("img", { name: "Pairing QR code" }).waitFor();
    expect(await page.getByLabel("Pairing link", { exact: true }).inputValue()).not.toContain(
      "secret",
    );
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      await page.getByLabel("Pairing link", { exact: true }).inputValue(),
    );
    await page.getByRole("button", { name: "Copy pairing secret", exact: true }).click();
    expect((await controls(app)).copied).toBe(1);
    expect(await page.locator("body").innerText()).not.toContain("synthetic-pairing-secret");
    await screenshot(page, "transfer-pair-light.png");
    const pairingUrl = await page.getByLabel("Pairing link", { exact: true }).inputValue();
    await page.getByRole("button", { name: /^Other Scopes/ }).click();
    expect((await controls(app)).cancelled).toBe(0);
    await page.getByRole("button", { name: /^Other Scopes/ }).click();
    expect(await page.getByLabel("Pairing link", { exact: true }).inputValue()).toBe(pairingUrl);
    await page.getByLabel("Search settings").fill("appearance");
    expect((await controls(app)).cancelled).toBe(0);
    await page.getByLabel("Search settings").fill("other scopes");
    expect(await page.getByLabel("Pairing link", { exact: true }).inputValue()).toBe(pairingUrl);
    await page.getByRole("button", { name: "Cancel invitation", exact: true }).click();
    expect((await controls(app)).cancelled).toBe(1);
    await page.getByRole("button", { name: "Enter pairing link", exact: true }).click();
    await page
      .getByLabel("Pairing link", { exact: true })
      .fill("scope-transfer://v1/#synthetic-pair-public-link");
    await page.getByLabel("Pairing secret", { exact: true }).fill("wrong");
    await page.getByLabel("Search settings").fill("appearance");
    await page.getByLabel("Search settings").fill("other scopes");
    expect(await page.getByLabel("Pairing secret", { exact: true }).inputValue()).toBe("wrong");
    await page.getByRole("button", { name: "Pair Scope", exact: true }).click();
    await page.getByText("Pairing secret does not match. Retry.", { exact: false }).waitFor();
    await page.getByLabel("Pairing secret", { exact: true }).fill("synthetic-pairing-secret");
    await page.getByRole("button", { name: "Pair Scope", exact: true }).click();
    await page.getByText("Travel Mac", { exact: true }).waitFor();
    expect(await page.getByLabel("Pairing secret", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Forget Travel Mac", exact: true }).click();
    await page
      .getByText("Forget Travel Mac? You will need to pair again to exchange tabs.")
      .waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Forget Travel Mac", exact: true }).click();
    await page.getByRole("button", { name: "Forget Scope", exact: true }).click();
    await page.getByText("No other Scopes paired.").waitFor();
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);

test("Send tab shows QR, cancellation, expiry, import progress, and completion while preserving HTML", async () => {
  const f = await desktopFixture();
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    const sourceFile = join(f.directory, "review.html");
    await writeFile(sourceFile, "<label>Draft<input aria-label='Artifact draft'></label>");
    await f.cli(
      "add",
      sourceFile,
      "--id",
      "transfer-source",
      "--title",
      "Draft review with a long title that remains open during transfer",
    );
    const client = await f.connect();
    const artifact = (await client.list()).find((entry) => entry.id === "transfer-source")!;
    await installTransferResponses(app, artifact);
    await page.frameLocator("iframe").getByLabel("Artifact draft").fill("Unsaved reader input");
    const send = async () => {
      await page.getByRole("button", { name: "Search and controls" }).click();
      await page.getByRole("button", { name: "Send tab", exact: true }).click();
      await page.getByRole("button", { name: "Create transfer link", exact: true }).click();
      await page.getByRole("img", { name: "Transfer QR code" }).waitFor();
    };
    await send();
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      await page.getByLabel("Transfer link", { exact: true }).inputValue(),
    );
    await screenshot(page, "transfer-send-light.png");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect((await controls(app)).cancelled).toBe(1);
    expect(await page.frameLocator("iframe").getByLabel("Artifact draft").inputValue()).toBe(
      "Unsaved reader input",
    );
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Search settings").fill("appearance");
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(640, 820));
    await send();
    await screenshot(page, "transfer-send-dark-narrow.png");
    await app.evaluate(() => {
      (globalThis as unknown as TestMain).scopeTransferUITest.state = "expired";
    });
    await page.getByText("This invitation expired. Create a new link to retry.").waitFor();
    await page.getByRole("button", { name: "Create new link", exact: true }).click();
    await page.getByRole("img", { name: "Transfer QR code" }).waitFor();
    await app.evaluate(() => {
      (globalThis as unknown as TestMain).scopeTransferUITest.state = "importing";
    });
    await page.getByText("Import in progress. Keep Scope open.").waitFor();
    expect(
      await page.getByRole("button", { name: "Import in progress", exact: true }).isDisabled(),
    ).toBe(true);
    expect(await page.getByRole("button", { name: "Close", exact: true }).isEnabled()).toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:transfer-link", {
        url: "scope-transfer://v1/#queued-pair-public-link",
        kind: "pair",
      }),
    );
    expect(
      await page.getByRole("dialog", { name: "Pair another Scope", exact: true }).count(),
    ).toBe(0);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Pair another Scope", exact: true }).waitFor();
    expect(await page.getByLabel("Pairing link", { exact: true }).inputValue()).toBe(
      "scope-transfer://v1/#queued-pair-public-link",
    );
    expect((await controls(app)).cancelled).toBe(1);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await app.evaluate(() => {
      (globalThis as unknown as TestMain).scopeTransferUITest.state = "delivered";
    });
    await send();
    await app.evaluate(() => {
      (globalThis as unknown as TestMain).scopeTransferUITest.state = "delivered";
    });
    await page.getByText("Tab imported on the other Scope.").waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect((await controls(app)).cancelled).toBe(1);
    expect(await page.frameLocator("iframe").getByLabel("Artifact draft").inputValue()).toBe(
      "Unsaved reader input",
    );
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);

test("Import reviews metadata before confirmation and duplicate import opens the existing tab", async () => {
  const f = await desktopFixture();
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await f.cli(
      "text",
      "Imported content",
      "--id",
      "transfer-target",
      "--title",
      "A received review",
    );
    const client = await f.connect();
    const artifact = (await client.list()).find((entry) => entry.id === "transfer-target")!;
    await page.getByText("Imported content", { exact: true }).waitFor();
    await installTransferResponses(app, artifact);
    const importLink = "scope-transfer://v1/#synthetic-tab-public-link";
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Import tab", exact: true }).click();
    await page.getByLabel("Transfer link", { exact: true }).fill("invalid");
    await page.getByRole("button", { name: "Review tab", exact: true }).click();
    await page.getByText("Paste the complete transfer link.", { exact: false }).waitFor();
    await page.getByLabel("Transfer link", { exact: true }).fill(importLink);
    await page.getByRole("button", { name: "Review tab", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Import tab", exact: true });
    await dialog.getByText("Travel Mac", { exact: true }).waitFor();
    await dialog.getByText("1,024 bytes", { exact: true }).waitFor();
    expect((await controls(app)).imported).toBe(0);
    await screenshot(page, "transfer-import-light.png");
    await app.evaluate(() => {
      (globalThis as unknown as TestMain).scopeTransferUITest.pauseImport = true;
    });
    await dialog.getByRole("button", { name: "Import tab", exact: true }).click();
    await dialog.getByRole("button", { name: "Importing…", exact: true }).waitFor();
    const queuedImportLink = "scope-transfer://v1/#queued-tab-public-link";
    const queuedLinks = [
      queuedImportLink,
      ...["second", "third", "fourth", "overflow"].map(
        (name) => `scope-transfer://v1/#${name}-queued-link`,
      ),
    ];
    await app.evaluate(({ BrowserWindow }, links) => {
      for (const url of links)
        BrowserWindow.getAllWindows()[0].webContents.send("scope:transfer-link", {
          url,
          kind: "tab",
        });
    }, queuedLinks);
    expect(await dialog.getByRole("button", { name: "Importing…", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(await page.getByLabel("Transfer link", { exact: true }).count()).toBe(0);
    expect(
      await page
        .getByText(
          "Four transfer links are waiting. Finish a transfer, then open the new link again.",
          { exact: true },
        )
        .count(),
    ).toBe(1);
    await app.evaluate(() => {
      const state = globalThis as unknown as TestMain;
      state.scopeTransferUITest.pauseImport = false;
      state.resumeScopeImport?.();
    });
    await page.getByLabel("Transfer link", { exact: true }).waitFor();
    expect(await page.getByLabel("Transfer link", { exact: true }).inputValue()).toBe(
      queuedImportLink,
    );
    for (const link of queuedLinks.slice(0, 4)) {
      await expect
        .poll(() => page.getByLabel("Transfer link", { exact: true }).inputValue())
        .toBe(link);
      await page.getByRole("button", { name: "Close", exact: true }).click();
    }
    await dialog.waitFor({ state: "hidden" });
    expect((await controls(app)).imported).toBe(1);
    await app.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()[0].webContents.send("scope:transfer-link", {
          url,
          kind: "tab",
        }),
      importLink,
    );
    await page.getByLabel("Transfer link", { exact: true }).waitFor();
    expect(await page.getByLabel("Transfer link", { exact: true }).inputValue()).toBe(importLink);
    expect((await controls(app)).imported).toBe(1);
    await page.getByRole("button", { name: "Review tab", exact: true }).click();
    await page.getByText("This tab is already imported. Open your local copy.").waitFor();
    await page.getByRole("button", { name: "Open existing tab", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await page.getByRole("tab", { name: "A received review", exact: false }).count()).toBe(
      1,
    );
    await page.getByText("Imported content", { exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:transfer-link", {
        url: "scope-transfer://v1/#synthetic-pair-public-link",
        kind: "pair",
      }),
    );
    await page.getByRole("dialog", { name: "Pair another Scope", exact: true }).waitFor();
    expect(await page.getByLabel("Pairing link", { exact: true }).inputValue()).toContain(
      "synthetic-pair-public-link",
    );
    expect(await page.getByLabel("Pairing secret", { exact: true }).inputValue()).toBe("");
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
