import { expect, test } from "vite-plus/test";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desktopFixture } from "./desktop-fixture.ts";

test("Electron receives and reopens interactive HTML and keeps development keys out of files", async () => {
  const { directory, settingsDirectory, connectionFile, launch, connect, cli } =
    await desktopFixture();
  let application: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await expect(cli("list")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Open Scope on this Mac"),
    });
    application = await launch();
    const page = await application.firstWindow();
    const client = await connect();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await cli(
      "text",
      "# Actual report\nPersist me.",
      "--title",
      "Review",
      "--id",
      "review",
      "--kind",
      "markdown",
    );
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    await page.getByRole("heading", { name: "Actual report" }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    expect(await page.getByRole("navigation", { name: "Open artifacts" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("heading", { name: "Actual report" }).isVisible()).toBe(true);
    await client.publish(
      "prototype",
      {
        title: "Interactive preview",
        kind: "html",
        mediaType: "text/html",
        fileName: "prototype.html",
        expectedRevision: 0,
      },
      new TextEncoder().encode(
        `<h1>Interactive preview</h1><button onclick="this.textContent='Clicked'">Try prototype</button><script>document.body.dataset.executed='yes'</script>`,
      ),
    );
    expect(await page.getByRole("heading", { name: "Actual report" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByLabel("Search artifacts", { exact: true }).fill("Interactive preview");
    await page.getByRole("button", { name: "Interactive preview html" }).click();
    const preview = page.frameLocator('iframe[title="Interactive preview"]');
    await preview.getByRole("heading", { name: "Interactive preview" }).waitFor();
    expect(await preview.locator("body").getAttribute("data-executed")).toBe("yes");
    await preview.getByRole("button", { name: "Try prototype" }).click();
    await preview.getByRole("button", { name: "Clicked", exact: true }).waitFor();
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    expect(
      await frame.evaluate(() => ({
        node: typeof (globalThis as unknown as { require?: unknown }).require,
        scope: typeof (globalThis as unknown as { scope?: unknown }).scope,
      })),
    ).toEqual({ node: "undefined", scope: "undefined" });
    expect(
      await frame.evaluate(() => {
        try {
          return Boolean(parent.document.body);
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    expect(await page.getByText("Hub connection", { exact: true }).count()).toBe(0);
    expect(await page.getByLabel("Hub token").count()).toBe(0);
    await page.getByRole("button", { name: "Diagram generation", exact: true }).click();
    await page.getByRole("switch", { name: "Diagram generation", exact: true }).click();
    await page.getByRole("button", { name: "OpenRouter", exact: true }).click();
    await page.getByLabel("OpenRouter API key").fill("synthetic-desktop-api-key");
    await page.getByRole("button", { name: "Save key" }).click();
    await page.getByText("Settings saved.").waitFor();
    expect(await page.getByLabel("OpenRouter API key").inputValue()).toBe("");
    const database = new DatabaseSync(join(settingsDirectory, "desktop.db"), { readOnly: true });
    try {
      expect(JSON.stringify(database.prepare("SELECT * FROM preferences").all())).not.toContain(
        "synthetic-desktop-api-key",
      );
    } finally {
      database.close();
    }
    expect(await page.evaluate(() => localStorage.getItem("scope.workspace.v1"))).toBeNull();
    await page.getByRole("button", { name: "Remove key" }).click();
    await page.getByText("No key saved").waitFor();
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    expect(failures).toEqual([]);
    await application.close();
    application = undefined;
    await expect(cli("text", "Offline publication", "--id", "not-queued")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Cannot reach Scope"),
    });
    expect(
      (await readFile(join(settingsDirectory, "artifacts", "scope.db"))).subarray(0, 15).toString(),
    ).toBe("SQLite format 3");
    application = await launch();
    const restored = await connect();
    expect((await restored.list()).map((artifact) => artifact.id).sort()).toEqual([
      "prototype",
      "review",
    ]);
    expect(JSON.parse((await cli("get", "review")).stdout)).toMatchObject({
      id: "review",
      revision: 1,
    });
    const reopened = await application.firstWindow();
    await reopened
      .frameLocator('iframe[title="Interactive preview"]')
      .getByRole("heading", { name: "Interactive preview" })
      .waitFor();
    await reopened
      .frameLocator('iframe[title="Interactive preview"]')
      .getByRole("button", { name: "Try prototype" })
      .click();
    await reopened
      .frameLocator('iframe[title="Interactive preview"]')
      .getByRole("button", { name: "Clicked", exact: true })
      .waitFor();
    expect(await reopened.getByRole("button", { name: "Close Review", exact: true }).count()).toBe(
      1,
    );
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
