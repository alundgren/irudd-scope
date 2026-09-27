import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";

test("Settings finds agent tools and shows update progress, retry, and restart without leaving the artifact", async () => {
  const { directory, launch, cli } = await desktopFixture();
  const application = await launch();
  try {
    const page = await application.firstWindow();
    await cli(
      "text",
      "Keep this artifact open",
      "--title",
      "Review with a long title that stays open during installation",
      "--id",
      "install-review",
    );
    await page
      .getByRole("button", {
        name: "Review with a long title that stays open during installation text",
      })
      .click();
    await page.getByRole("button", { name: "Find artifacts and tools" }).click();
    await page.getByLabel("Search artifacts", { exact: true }).fill("cli");
    await page.getByRole("button", { name: "Agent tools Setting" }).click();
    expect(await page.getByRole("button", { name: "Install CLI", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(await page.getByLabel("Search settings").inputValue()).toBe("cli");
    await page.getByRole("button", { name: "Done", exact: true }).click();

    await application.evaluate(({ ipcMain, BrowserWindow }) => {
      const updates = {
        phase: "idle",
        message: "Scope is up to date.",
        currentCommit: "a".repeat(40),
      };
      const tools = {
        available: true,
        cliInstalled: false,
        cliPath: "/Users/example/.local/bin/irudd-scope",
        skillInstalled: false,
        busy: null,
        message: "",
      };
      for (const channel of [
        "updates",
        "check-for-updates",
        "cancel-update",
        "agent-tools",
        "install-cli",
        "install-skill",
      ])
        ipcMain.removeHandler(`scope:${channel}`);
      ipcMain.handle("scope:updates", () => updates);
      ipcMain.handle("scope:agent-tools", () => tools);
      ipcMain.handle("scope:check-for-updates", () => {
        updates.phase = "building";
        updates.message = "Building the update on this Mac…";
        BrowserWindow.getAllWindows()[0].webContents.send("scope:updates-changed", updates);
      });
      ipcMain.handle("scope:cancel-update", () => {
        updates.phase = "error";
        updates.message = "Could not prepare the update. Scope is still using the current version.";
        BrowserWindow.getAllWindows()[0].webContents.send("scope:updates-changed", updates);
      });
      ipcMain.handle("scope:install-cli", () => {
        tools.cliInstalled = true;
        tools.message = "CLI installed. Open a new terminal to use irudd-scope.";
        BrowserWindow.getAllWindows()[0].webContents.send("scope:agent-tools-changed", tools);
        return tools;
      });
      ipcMain.handle("scope:install-skill", () => {
        const failed = { ...tools, error: "Registry unavailable. Try again." };
        BrowserWindow.getAllWindows()[0].webContents.send("scope:agent-tools-changed", failed);
        return failed;
      });
    });
    await page.getByRole("button", { name: "Workspace menu" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Search settings").fill("agent");
    await page.getByRole("button", { name: "Install CLI", exact: true }).click();
    await page.getByText("CLI installed. Open a new terminal to use irudd-scope.").waitFor();
    await page.getByRole("button", { name: "Install skill", exact: true }).click();
    await page.getByText("Registry unavailable. Try again.").waitFor();
    expect(await page.getByRole("button", { name: "Install skill", exact: true }).isEnabled()).toBe(
      true,
    );
    await page.getByLabel("Search settings").fill("updates");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await page.getByRole("button", { name: "Cancel update", exact: true }).click();
    await page.getByRole("button", { name: "Retry update", exact: true }).waitFor();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:updates-changed", {
        phase: "ready",
        message: "Update ready. Restart when you are ready.",
        currentCommit: "a".repeat(40),
        nextCommit: "b".repeat(40),
      }),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Restart to update", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("Keep this artifact open", { exact: true }).waitFor();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Restart to update", exact: true }).waitFor();
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
