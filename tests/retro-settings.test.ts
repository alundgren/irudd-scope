import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";

test("retrospective settings automatically include this machine and preserve edits on conflict and restart", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    let settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro locations");
    const machine = settings.getByRole("group", { name: "This machine", exact: true });
    await machine.waitFor();
    expect(await settings.getByRole("button", { name: "Add source", exact: true }).count()).toBe(0);
    expect(await settings.getByRole("button", { name: "Remove source", exact: true }).count()).toBe(
      0,
    );
    expect(await settings.getByRole("textbox", { name: "Source name", exact: true }).count()).toBe(
      0,
    );
    const claude = machine.getByRole("switch", { name: "Claude sessions", exact: true });
    await claude.focus();
    await page.keyboard.press("Space");
    expect(await claude.getAttribute("aria-checked")).toBe("false");
    await machine.getByText("Runtime directories", { exact: true }).click();
    await machine.getByRole("textbox", { name: "Codex root", exact: true }).fill("~/.codex-work");
    const client = await fixture.connect();
    const initial = await client.retro({ action: "settings" });
    if (initial.type !== "configuration") throw new Error("Expected configuration.");
    expect(initial.configuration.sources).toMatchObject([
      { id: "local", name: "This machine", location: { type: "desktop" }, included: true },
    ]);
    await client.retro({
      action: "configure",
      requestId: randomUUID(),
      expectedVersion: initial.configuration.version,
      configuration: initial.configuration,
    });
    await settings.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect
      .poll(() => settings.getByRole("alert").textContent())
      .toContain("Your edits are kept");
    expect(
      await machine.getByRole("textbox", { name: "Codex root", exact: true }).inputValue(),
    ).toBe("~/.codex-work");
    await settings.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await expect.poll(() => claude.getAttribute("aria-checked")).toBe("true");
    await claude.click();
    await machine.getByRole("textbox", { name: "Codex root", exact: true }).fill("~/.codex-work");
    await settings.getByRole("button", { name: "Save settings", exact: true }).click();
    await settings.getByText("Retrospective settings saved.", { exact: true }).waitFor();
    const saved = await client.retro({ action: "settings" });
    if (saved.type !== "configuration") throw new Error("Expected configuration.");
    expect(saved.configuration.sources[0]).toMatchObject({
      id: "local",
      sshAlias: null,
      runtimeRoots: { codex: "~/.codex-work", claude: null },
      runtimes: ["codex"],
    });
    expect(saved.configuration.memory.enabled).toBe(false);
    await mkdir("/tmp/scope-retro-ui-evidence", { recursive: true });
    for (const appearance of ["light", "dark"] as const) {
      await settings.getByLabel("Search settings").fill("color scheme");
      await settings.getByLabel("Appearance", { exact: true }).selectOption(appearance);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
      await settings.getByLabel("Search settings").fill("retro");
      await page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 600, height: 640 },
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({
        path: join("/tmp/scope-retro-ui-evidence", `settings-${appearance}.png`),
      });
    }
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro");
    await expect
      .poll(() =>
        settings
          .getByRole("switch", { name: "Claude sessions", exact: true })
          .getAttribute("aria-checked"),
      )
      .toBe("false");
    await settings.getByText("Runtime directories", { exact: true }).click();
    expect(
      await settings.getByRole("textbox", { name: "Codex root", exact: true }).inputValue(),
    ).toBe("~/.codex-work");
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("paired remotes automatically appear in retrospective settings and disappear when removed", async () => {
  const fixture = await desktopFixture();
  const state = await HubState.open(join(fixture.directory, "hub"));
  const connectionFile = join(fixture.directory, "hub-connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro");
    await settings.getByRole("group", { name: "This machine", exact: true }).waitFor();
    await page.evaluate((url) => window.scope.pairRemote(url), state.pairUrl());
    const client = await fixture.connect();
    const reply = await client.retro({ action: "settings" });
    if (reply.type !== "configuration") throw new Error("Expected configuration.");
    const remote = reply.configuration.sources.find(
      (source) => source.location?.type === "remote",
    )!;
    expect(remote).toMatchObject({
      included: true,
      location: { type: "remote", endpoint: hub.url },
      sshAlias: null,
    });
    const group = settings.getByRole("group", { name: remote.name, exact: true });
    await group.getByText(hub.url, { exact: true }).waitFor();
    await group.getByRole("switch", { name: `Include ${remote.name}`, exact: true }).click();
    await settings.getByRole("button", { name: "Save settings", exact: true }).click();
    await settings.getByText("Retrospective settings saved.", { exact: true }).waitFor();
    const saved = await client.retro({ action: "settings" });
    if (saved.type !== "configuration") throw new Error("Expected configuration.");
    expect(saved.configuration.sources.find((source) => source.id === remote.id)?.included).toBe(
      false,
    );
    await page.evaluate((id) => window.scope.removeRemote(id), remote.id);
    await group.waitFor({ state: "hidden" });
    const removed = await client.retro({ action: "settings" });
    if (removed.type !== "configuration") throw new Error("Expected configuration.");
    expect(removed.configuration.sources.map((source) => source.id)).toEqual(["local"]);
  } finally {
    await application.close();
    await hub.close();
    state.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);
