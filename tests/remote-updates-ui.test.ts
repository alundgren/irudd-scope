import { expect, test } from "vite-plus/test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("Remotes shows update failures, details, retry progress, and the upgrade needed by an older hub", async () => {
  const f = await desktopFixture();
  const app = await f.launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const remotes = [
        {
          id: "12345678-1234-1234-1234-123456789012",
          name: "Development workstation with a long name",
          endpoint: "https://development-workstation.example.ts.net:8450",
          enabled: true,
          connection: "connected",
          message: "Connected. Publications arrive while Scope is open.",
          update: {
            supported: true,
            phase: "error",
            message: "The remote update failed. Retry the update.",
            output: "The build could not download its dependencies.",
          },
        },
        {
          id: "23456789-1234-1234-1234-123456789012",
          name: "Older remote installation",
          endpoint: "https://older.example.ts.net:8450",
          enabled: true,
          connection: "connected",
          message: "Connected. Publications arrive while Scope is open.",
          update: {
            supported: false,
            phase: "idle",
            message:
              "Run the standalone installer and irudd-scope setup once on this remote to enable automatic updates.",
            output: "",
          },
        },
      ];
      ipcMain.removeHandler("scope:remotes");
      ipcMain.removeHandler("scope:retry-remote-update");
      ipcMain.handle("scope:remotes", () => remotes);
      ipcMain.handle("scope:retry-remote-update", (_event, id) => {
        if (id !== remotes[0].id) throw new Error("Unexpected remote selected.");
        remotes[0].update = {
          supported: true,
          phase: "building",
          message: "Building the hub, CLI, and skill to match this Mac…",
          output: "",
        };
        BrowserWindow.getAllWindows()[0].webContents.send("scope:remotes-changed", remotes);
      });
    });
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const appearance of ["light", "dark"]) {
      await page.getByLabel("Search settings").fill("appearance");
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await page.getByLabel("Search settings").fill("remote update");
      await page.getByText("The remote update failed. Retry the update.").waitFor();
      expect(await page.getByRole("button", { name: "Retry update", exact: true }).count()).toBe(1);
      await page.getByText("Run the standalone installer", { exact: false }).waitFor();
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820),
        appearance === "light" ? 1280 : 640,
      );
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(appearance === "light" ? 1280 : 640);
      if (process.env.SCOPE_REVIEW_DIR) {
        await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: join(process.env.SCOPE_REVIEW_DIR, `remote-updates-${appearance}.png`),
        });
      }
    }
    await page.getByText("Update details", { exact: true }).click();
    await page.getByText("The build could not download its dependencies.").waitFor();
    await page.getByRole("button", { name: "Retry update", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Building the hub, CLI, and skill to match this Mac…").waitFor();
    expect(await page.getByRole("button", { name: "Retry update", exact: true }).count()).toBe(0);
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
