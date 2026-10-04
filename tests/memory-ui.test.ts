import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { desktopFixture } from "./desktop-fixture.ts";
import { MEMORY_REPOSITORY, memoryFixture } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("Memory settings turn sync on, show each machine, and warn about conflicts with an agent request", async () => {
  const f = await memoryFixture(cleanup);
  const memoryDirectory = f.root("mac");
  const fixture = await desktopFixture({
    env: { ...f.env("mac"), SCOPE_MEMORY_DIR: memoryDirectory },
  });
  const application = await fixture.launch();
  cleanup.push(() => application.close());
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByLabel("Search settings").fill("memory sync");
  const memorySwitch = settings.getByRole("switch", { name: "Memory sync", exact: true });
  await expect.poll(() => memorySwitch.isEnabled()).toBe(true);
  await memorySwitch.click();
  await settings.getByText("No memory repository yet.", { exact: false }).waitFor();
  await settings.getByRole("button", { name: "Copy agent request", exact: true }).click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    "create it as a private repository",
  );

  const client = await fixture.connect();
  await client.connectMemory(MEMORY_REPOSITORY);
  await settings.getByText(MEMORY_REPOSITORY, { exact: true }).waitFor();
  const machines = settings.getByRole("list", { name: "Memory sync by machine" });
  await machines.getByText("irudd-okf bundle personal is registered.").waitFor();

  await settings.getByLabel("Search settings").fill("retrospectives");
  const suggestions = settings.getByRole("switch", { name: "Memory suggestions", exact: true });
  await suggestions.click();
  await settings.getByText(f.clone("mac"), { exact: true }).waitFor();
  expect(await settings.getByRole("button", { name: "Remove destination" }).count()).toBe(0);
  await settings.getByLabel("Search settings").fill("memory sync");
  await memorySwitch.click();
  await settings.getByLabel("Search settings").fill("retrospectives");
  await expect.poll(() => settings.getByText(f.clone("mac"), { exact: true }).count()).toBe(0);
  expect(await suggestions.isChecked()).toBe(true);
  await settings.getByLabel("Search settings").fill("memory sync");
  await memorySwitch.click();
  await machines.getByText("irudd-okf bundle personal is registered.").waitFor();
  await settings.getByLabel("Search settings").fill("retrospectives");
  await settings.getByText(f.clone("mac"), { exact: true }).waitFor();
  expect(await suggestions.isChecked()).toBe(true);
  await settings.getByLabel("Search settings").fill("memory sync");

  const laptop = new MemorySync({
    root: f.root("laptop"),
    machine: "laptop",
    env: f.env("laptop"),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => laptop.close());
  laptop.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await laptop.sync();
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("mac"), "index.md"), "Mac line.\n");
  await settings.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.keyboard.press("Escape");

  const notice = page.getByRole("alert").filter({ hasText: "Memory has 1 sync conflict" });
  await notice.waitFor();
  await notice.getByRole("button", { name: "Copy agent request", exact: true }).click();
  const request = await application.evaluate(({ clipboard }) => clipboard.readText());
  expect(request).toContain(`https://github.com/${MEMORY_REPOSITORY}/pull/1`);
  await page.getByRole("alert").getByText("Agent request copied.", { exact: false }).waitFor();

  const evidence = process.env.SCOPE_TEST_EVIDENCE_DIR ?? join(f.directory, "ui-evidence");
  await mkdir(evidence, { recursive: true });
  for (const appearance of ["light", "dark"] as const) {
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByLabel("Search settings").fill("color scheme");
    await settings.getByLabel("Appearance", { exact: true }).selectOption(appearance);
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(appearance);
    await page.setViewportSize(
      appearance === "light" ? { width: 1280, height: 820 } : { width: 600, height: 640 },
    );
    await settings.getByLabel("Search settings").fill("memory sync");
    await machines.waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: join(evidence, `settings-${appearance}.png`) });
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    await page.screenshot({ path: join(evidence, `banner-${appearance}.png`) });
  }
}, 120_000);

test("Memory status changes preserve an unsaved removal of a manual OKF destination", async () => {
  const f = await memoryFixture(cleanup);
  const fixture = await desktopFixture({
    env: { ...f.env("mac"), SCOPE_MEMORY_DIR: f.root("mac") },
  });
  const application = await fixture.launch();
  cleanup.push(() => application.close());
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
  await page.evaluate(async () => {
    await window.scope.setMemoryEnabled(true);
    const configuration = await window.scope.retroConfiguration();
    await window.scope.saveRetroConfiguration({
      requestId: crypto.randomUUID(),
      expectedVersion: configuration.version,
      configuration: {
        ...configuration,
        memory: {
          enabled: true,
          destinations: [
            {
              id: "manual-okf",
              type: "okf",
              scope: "operator",
              sourceId: configuration.sources[0].id,
              path: "/synthetic/manual-memory",
              available: true,
              verifiedAt: "2026-10-04T08:00:00.000Z",
            },
          ],
        },
      },
    });
  });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByLabel("Search settings").fill("retrospectives");
  await settings.getByText("/synthetic/manual-memory", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Remove destination", exact: true }).click();
  await settings.getByLabel("Search settings").fill("memory sync");
  const memorySwitch = settings.getByRole("switch", { name: "Memory sync", exact: true });
  await memorySwitch.click();
  await expect.poll(() => memorySwitch.isEnabled()).toBe(true);
  await memorySwitch.click();
  await expect.poll(() => memorySwitch.isEnabled()).toBe(true);
  await settings.getByLabel("Search settings").fill("retrospectives");
  expect(await settings.getByText("/synthetic/manual-memory", { exact: true }).count()).toBe(0);
  await settings.getByRole("button", { name: "Save settings", exact: true }).click();
  await settings.getByText("Retrospective settings saved.", { exact: true }).waitFor();
  expect(
    await page.evaluate(async () => (await window.scope.retroConfiguration()).memory.destinations),
  ).toEqual([]);
}, 60_000);
