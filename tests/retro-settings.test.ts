import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";

test("RETRO settings preserve unsaved source edits on conflict and persist named SSH sources without credentials", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    let settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro sources");
    await settings.getByRole("button", { name: "Add source", exact: true }).click();
    await settings
      .getByRole("textbox", { name: "Source name", exact: true })
      .fill("Devbox with a long descriptive source name");
    await settings.getByLabel("Access", { exact: true }).selectOption("ssh");
    await settings.getByRole("textbox", { name: "SSH alias", exact: true }).fill("dev-box");
    const claude = settings.getByRole("switch", { name: "Claude sessions", exact: true });
    await claude.focus();
    await page.keyboard.press("Space");
    expect(await claude.getAttribute("aria-checked")).toBe("false");
    await page.keyboard.press("Space");
    expect(await claude.getAttribute("aria-checked")).toBe("true");
    await settings.getByText("Runtime directories", { exact: true }).click();
    await settings.getByRole("textbox", { name: "Codex root", exact: true }).fill("~/.codex-work");
    const client = await fixture.connect();
    const initial = await client.retro({ action: "settings" });
    if (initial.type !== "configuration") throw new Error("Expected configuration.");
    await client.retro({
      action: "configure",
      requestId: randomUUID(),
      expectedVersion: initial.configuration.version,
      configuration: initial.configuration,
    });
    await settings.getByRole("button", { name: "Save RETRO settings", exact: true }).click();
    await expect
      .poll(() => settings.getByRole("alert").textContent())
      .toContain("Your edits are kept");
    expect(
      await settings.getByRole("textbox", { name: "Source name", exact: true }).inputValue(),
    ).toBe("Devbox with a long descriptive source name");
    expect(
      await settings.getByRole("textbox", { name: "SSH alias", exact: true }).inputValue(),
    ).toBe("dev-box");
    await settings.getByRole("button", { name: "Reload saved settings", exact: true }).click();
    await settings
      .getByText(
        "No sources configured. Add your Mac or an SSH source, or ask your coding agent to configure them.",
        { exact: true },
      )
      .waitFor();
    await settings.getByRole("button", { name: "Add source", exact: true }).click();
    await settings.getByRole("textbox", { name: "Source name", exact: true }).fill("Devbox");
    await settings.getByLabel("Access", { exact: true }).selectOption("ssh");
    await settings.getByRole("textbox", { name: "SSH alias", exact: true }).fill("dev-box");
    await settings.getByText("Runtime directories", { exact: true }).click();
    await settings.getByRole("textbox", { name: "Codex root", exact: true }).fill("~/.codex-work");
    const memory = settings.getByRole("switch", { name: "Memory suggestions", exact: true });
    expect(await memory.getAttribute("aria-checked")).toBe("false");
    await settings.getByRole("button", { name: "Save RETRO settings", exact: true }).click();
    await settings.getByText("RETRO settings saved.", { exact: true }).waitFor();
    const saved = await client.retro({ action: "settings" });
    if (saved.type !== "configuration") throw new Error("Expected configuration.");
    expect(saved.configuration.sources[0]).toMatchObject({
      name: "Devbox",
      sshAlias: "dev-box",
      runtimeRoots: { codex: "~/.codex-work", claude: null },
      runtimes: ["codex", "claude"],
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
      .poll(() => settings.getByRole("textbox", { name: "Source name", exact: true }).inputValue())
      .toBe("Devbox");
    expect(
      await settings.getByRole("textbox", { name: "SSH alias", exact: true }).inputValue(),
    ).toBe("dev-box");
    expect(
      await settings.getByRole("textbox", { name: /password|secret|credential/i }).count(),
    ).toBe(0);
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("removing a source also removes its hidden memory destinations and the saved settings reload", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const client = await fixture.connect();
    const initial = await client.retro({ action: "settings" });
    if (initial.type !== "configuration") throw new Error("Expected configuration.");
    await client.retro({
      action: "configure",
      requestId: randomUUID(),
      expectedVersion: initial.configuration.version,
      configuration: {
        ...initial.configuration,
        sources: [
          {
            id: "devbox",
            name: "Devbox",
            sshAlias: "dev-box",
            included: true,
            runtimes: ["codex"],
            runtimeRoots: { codex: null, claude: null },
          },
        ],
        memory: {
          enabled: false,
          destinations: [
            {
              id: "personal-rules",
              sourceId: "devbox",
              path: "~/.agents/AGENTS.md",
              type: "instructions",
              scope: "operator",
              available: true,
              verifiedAt: "2026-10-04T08:00:00.000Z",
            },
          ],
        },
      },
    });
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro");
    await settings.getByRole("textbox", { name: "Source name", exact: true }).waitFor();
    expect(
      await settings
        .getByRole("switch", { name: "Memory suggestions" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(await settings.getByRole("button", { name: "Remove destination" }).count()).toBe(0);
    await settings.getByRole("button", { name: "Remove source", exact: true }).click();
    await settings.getByRole("button", { name: "Save RETRO settings", exact: true }).click();
    await settings.getByText("RETRO settings saved.", { exact: true }).waitFor();
    const saved = await client.retro({ action: "settings" });
    if (saved.type !== "configuration") throw new Error("Expected configuration.");
    expect(saved.configuration.sources).toEqual([]);
    expect(saved.configuration.memory).toEqual({ enabled: false, destinations: [] });
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByLabel("Search settings").fill("retro");
    await settings.getByText(/No sources configured/).waitFor();
    expect(await settings.getByRole("textbox", { name: "Source name", exact: true }).count()).toBe(
      0,
    );
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);
