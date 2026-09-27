import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";

const exec = promisify(execFile);

test("Settings pairs a remote, shows publications, disconnects, and removes its access", async () => {
  const f = await desktopFixture();
  const state = await HubState.open(join(f.directory, "hub"));
  const connectionFile = join(f.directory, "remote.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const app = await f.launch();
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_CONNECTION_FILE: connectionFile,
        SCOPE_ENDPOINT: undefined,
        SCOPE_TOKEN: undefined,
        SCOPE_TOKEN_FILE: undefined,
      },
    });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByLabel("Search artifacts", { exact: true }).fill("pair");
    await page.getByRole("button", { name: "Remotes Setting" }).click();
    await page.getByText("No remotes paired.").waitFor();
    await page.getByLabel("Pairing URL").fill("invalid");
    await page.getByRole("button", { name: "Pair remote", exact: true }).click();
    await page.getByText("Paste the complete pairing URL", { exact: false }).waitFor();
    await page.getByLabel("Pairing URL").fill(state.pairUrl());
    await page.getByText(`Pair with ${hub.url}`).waitFor();
    await page.getByRole("button", { name: "Pair remote", exact: true }).click();
    await page.getByText("Connected. Publications arrive while Scope is open.").waitFor();
    expect(await page.getByLabel("Pairing URL").inputValue()).toBe("");
    await cli(
      "text",
      "A publication from the paired remote",
      "--id",
      "remote-ui",
      "--title",
      "Remote review with a long title to check workspace navigation",
    );
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("A publication from the paired remote", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    for (const appearance of ["light", "dark"]) {
      await page.getByLabel("Search settings").fill("appearance");
      await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
      await page.getByLabel("Search settings").fill("remotes");
      await app.evaluate(
        ({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0].setSize(width, 820);
        },
        appearance === "light" ? 1280 : 640,
      );
      await expect
        .poll(() => page.evaluate(() => window.innerWidth))
        .toBe(appearance === "light" ? 1280 : 640);
      if (process.env.SCOPE_REVIEW_DIR) {
        await mkdir(process.env.SCOPE_REVIEW_DIR, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          path: join(process.env.SCOPE_REVIEW_DIR, `remotes-${appearance}.png`),
        });
      }
    }
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByText("Disconnected.", { exact: true }).waitFor();
    await expect(cli("list")).rejects.toMatchObject({
      stderr: expect.stringContaining("disconnected"),
    });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Connected. Publications arrive while Scope is open.").waitFor();
    await page.getByRole("button", { name: "Remove remote", exact: true }).click();
    await page.getByText("No remotes paired.").waitFor();
    expect(state.status().pairedMac).toBeNull();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText("A publication from the paired remote", { exact: true }).waitFor();
  } finally {
    await app.close();
    await hub.close();
    state.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
