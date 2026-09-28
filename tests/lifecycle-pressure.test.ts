import { expect, test } from "vite-plus/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Artifact } from "@irudd-scope/protocol";
import { desktopFixture } from "./desktop-fixture.ts";
import { tabArtifactId } from "../apps/desktop/src/workspace/contract.ts";
import {
  contentCounts,
  pressureContent,
  pressureHub,
  pressureSample,
  pressureWorkers,
} from "./pressure-fixture.ts";

function setting(name: string, fallback: number, maximum: number, minimum = 1) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
const cycles = setting("SCOPE_PRESSURE_CYCLES", 2, 100);
const count = setting("SCOPE_PRESSURE_COUNT", 12, 100);
const payloadKiB = setting("SCOPE_PRESSURE_KIB", 8, 1024);
const useCli = process.env.SCOPE_PRESSURE_CLI === "1";
const output = process.env.SCOPE_PRESSURE_OUTPUT;
const settleMs = setting("SCOPE_PRESSURE_SETTLE_MS", output ? 2000 : 0, 30_000, 0);

test(
  "concurrent local and relayed publications drain queued tabs, survive restart, and reclaim content after repeated cycles",
  async () => {
    const f = await desktopFixture();
    const hub = await pressureHub(f.directory);
    let application = await f.launch();
    let page = await application.firstWindow();
    let local = await f.connect();
    const pageErrors: string[] = [];
    const observeErrors = () => page.on("pageerror", (error) => pageErrors.push(error.message));
    observeErrors();
    let samplingPaused = false;
    let sampling: Promise<void> | undefined;
    let phase = "starting";
    let succeeded = false;
    const samples: unknown[] = [];
    let samplingErrors = 0;
    const sample = async (label: string) => {
      if (output)
        samples.push({
          label,
          elapsedMs: Math.round(performance.now() - started),
          ...(await pressureSample(application, f.directory, f.settingsDirectory)),
        });
    };
    const started = performance.now();
    const timer = output
      ? setInterval(() => {
          if (samplingPaused || sampling) return;
          sampling = sample(phase)
            .catch(() => {
              samplingErrors++;
            })
            .finally(() => {
              sampling = undefined;
            });
        }, 2000)
      : undefined;
    const artifacts = new Map<string, Artifact>();
    const idFor = (cycle: number, index: number) => `pressure-${cycle}-${index}`;
    const clientFor = (index: number) => (index % 2 ? hub.client : local);
    const cliFor = (index: number) => (index % 2 ? hub.cli : f.cli);
    const publish = async (cycle: number, index: number, revision: number) => {
      const id = idFor(cycle, index);
      const { bytes, ...metadata } = pressureContent(index, cycle, revision, payloadKiB);
      const expectedRevision = artifacts.get(id)?.revision ?? 0;
      let artifact: Artifact;
      if (useCli) {
        const path = join(f.directory, `${id}-${metadata.fileName}`);
        await writeFile(path, bytes);
        const args = expectedRevision
          ? ["update", id, path]
          : ["add", path, "--id", id, "--title", id];
        artifact = JSON.parse(
          (await cliFor(index)(...args, "--agent", "synthetic-pressure-test")).stdout,
        );
      } else {
        artifact = await clientFor(index).publish(
          id,
          { ...metadata, title: id, expectedRevision },
          bytes,
        );
      }
      artifacts.set(id, artifact);
      expect(Buffer.from(await clientFor(index).content(id, artifact.revision))).toEqual(bytes);
    };
    const remove = async (cycle: number, index: number) => {
      const id = idFor(cycle, index);
      if (useCli) await cliFor(index)("delete", id);
      else await clientFor(index).delete(id);
      artifacts.delete(id);
    };
    const waitTabs = (n: number) =>
      expect.poll(() => page.getByRole("tab").count(), { timeout: 30_000 }).toBe(n);
    const checkEmpty = async () => {
      await waitTabs(0);
      expect(await local.list()).toEqual([]);
      const counts = contentCounts(f.settingsDirectory);
      expect(counts.integrity).toBe("ok");
      expect(counts.foreignKeys).toEqual([]);
      expect(Object.values(counts.rows)).toEqual([0, 0, 0, 0, 0]);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    };
    const shrink = async () => {
      const desktop = await local.shrink();
      const remote = await hub.shrink();
      const databases = [...desktop.databases, ...remote.databases];
      expect(databases.every((entry) => entry.status === "completed")).toBe(true);
      return databases;
    };
    try {
      await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
      await page.evaluate((url) => window.scope.pairRemote(url), hub.pairingUrl);
      await expect
        .poll(() => page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
        .toBe("connected");

      phase = "warm-up";
      await pressureWorkers(12, (index) => publish(-1, index, 1));
      await waitTabs(12);
      const diagram = await page.evaluate(async () =>
        (await window.scope.workspace())?.tabs.find((tab) => tab.type === "diagram"),
      );
      expect(diagram).toBeDefined();
      await page.getByRole("tab", { name: diagram!.title, exact: true }).click();
      await page
        .getByRole("tabpanel", { name: diagram!.title, exact: true })
        .locator(".excalidraw canvas")
        .first()
        .waitFor();
      await pressureWorkers(12, (index) => remove(-1, index));
      await checkEmpty();
      const baseline = await shrink();
      await delay(settleMs);
      await sample("warm-empty");

      phase = "overflow";
      await publish(0, 0, 1);
      await waitTabs(1);
      await pressureWorkers(119, (index) => publish(0, index + 1, 1));
      await waitTabs(100);
      await page.getByRole("status").filter({ hasText: "20 publications are waiting" }).waitFor();
      expect(await page.getByRole("tab", { selected: true }).textContent()).toBe(idFor(0, 0));
      const filled = contentCounts(f.settingsDirectory);
      expect(filled.rows.live_tabs).toBe(120);
      expect(filled.rows.artifacts).toBe(120);
      expect(filled.rows.blobs).toBeLessThan(120);
      await sample("overflow-full");
      for (const appearance of ["light", "dark"] as const) {
        await page.keyboard.press("ControlOrMeta+,");
        await page.getByLabel("Search settings").fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .waitFor({ state: "hidden" });
        await page.setViewportSize(
          appearance === "light" ? { width: 1280, height: 820 } : { width: 700, height: 620 },
        );
        await page.getByRole("status").filter({ hasText: "20 publications are waiting" }).waitFor();
        if (process.env.SCOPE_TEST_SCREENSHOTS) {
          await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            path: join(process.env.SCOPE_TEST_SCREENSHOTS, `pressure-${appearance}.png`),
          });
        }
      }

      const duplicate = artifacts.get(idFor(0, 1))!;
      expect(duplicate.blob).toBe(artifacts.get(idFor(0, 0))!.blob);
      await page.getByRole("button", { name: `Close ${idFor(0, 0)}`, exact: true }).click();
      artifacts.delete(idFor(0, 0));
      await page.getByRole("status").filter({ hasText: "19 publications are waiting" }).waitFor();
      await waitTabs(100);
      expect(contentCounts(f.settingsDirectory).rows.blobs).toBe(filled.rows.blobs);
      expect(Buffer.from(await hub.client.content(duplicate.id))).toEqual(
        pressureContent(1, 0, 1, payloadKiB).bytes,
      );

      const saved = await page.evaluate(() => window.scope.workspace());
      const draftTab = saved!.tabs.find((tab) => tab.type === "diagram")!;
      await page.evaluate(
        async (tab) =>
          window.scope.saveDiagramDraft(tab.id, {
            version: 1,
            content: '{"type":"excalidraw","elements":[],"files":{}}',
            revision: 1,
            dirty: true,
            messages: [{ role: "user", text: "Synthetic unsent work" }],
            intent: "Synthetic draft",
            chatOpen: true,
            viewport: { zoom: 1, scrollX: 0, scrollY: 0 },
          }),
        draftTab,
      );
      samplingPaused = true;
      await sampling;
      phase = "overflow-restart";
      await application.close();
      application = await f.launch();
      page = await application.firstWindow();
      observeErrors();
      local = await f.connect();
      samplingPaused = false;
      await waitTabs(100);
      await page.getByRole("status").filter({ hasText: "19 publications are waiting" }).waitFor();
      expect(await page.evaluate((id) => window.scope.diagramDraft(id), draftTab.id)).toMatchObject(
        { intent: "Synthetic draft" },
      );
      const restored = await page.evaluate(() => window.scope.workspace());
      expect(restored?.tabs.map((tab) => tab.id)).toEqual(saved!.tabs.map((tab) => tab.id));
      // Test profiles keep credentials in memory, so restart needs fresh pairing.
      await page.evaluate((url) => window.scope.pairRemote(url), hub.renewPairing());
      await expect
        .poll(() => page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
        .toBe("connected");
      // Delete only the current visible set. The remaining publications must open themselves.
      await pressureWorkers(restored!.tabs.length, async (index) => {
        const tab = restored!.tabs[index];
        await clientFor(index).delete(tabArtifactId(tab)!);
      });
      await waitTabs(19);
      const remainingArtifacts = await local.list();
      expect(remainingArtifacts.length).toBe(19);
      // Deletions and queued arrivals update the tab list separately.
      await expect
        .poll(async () => (await page.getByRole("tab").allTextContents()).sort())
        .toEqual(remainingArtifacts.map((artifact) => artifact.title).sort());
      await sample("overflow-drained");
      for (let remaining = 19; remaining > 0; remaining--) {
        await page.getByRole("tab", { selected: true }).press("ControlOrMeta+w");
        await waitTabs(remaining - 1);
      }
      await checkEmpty();
      expect(await local.delete(duplicate.id)).toEqual({ id: duplicate.id, deleted: false });
      artifacts.clear();
      await delay(settleMs);
      await sample("restarted-empty");

      for (let cycle = 1; cycle <= cycles; cycle++) {
        phase = `cycle-${cycle}-create`;
        await pressureWorkers(count, (index) => publish(cycle, index, 1));
        await waitTabs(count);
        await delay(settleMs);
        await sample(phase);
        phase = `cycle-${cycle}-update`;
        await pressureWorkers(count, (index) => publish(cycle, index, 2));
        await delay(settleMs);
        await sample(phase);
        phase = `cycle-${cycle}-delete`;
        await pressureWorkers(count, (index) => remove(cycle, index));
        await checkEmpty();
        await delay(settleMs);
        await sample(`cycle-${cycle}-empty`);
      }
      phase = "final-shrink";
      const final = await shrink();
      for (const [index, database] of final.entries()) {
        expect(database.after.main + database.after.wal).toBeLessThanOrEqual(
          baseline[index].after.main + baseline[index].after.wal + 32_768,
        );
        expect(database.after.allocated).toBeLessThanOrEqual(
          baseline[index].after.allocated + 32_768,
        );
      }
      expect(final[0].after.main).toBe(baseline[0].after.main);
      await checkEmpty();
      await delay(settleMs);
      await sample("final-empty");
      expect(pageErrors).toEqual([]);
      succeeded = true;
    } finally {
      clearInterval(timer);
      samplingPaused = true;
      await sampling;
      try {
        if (output) {
          await mkdir(dirname(output), { recursive: true });
          await writeFile(
            output,
            JSON.stringify(
              {
                succeeded,
                phase,
                cycles,
                count,
                payloadKiB,
                settleMs,
                overflowCount: 120,
                transport: useCli ? "cli" : "protocol-client",
                workers: 4,
                samplingErrors,
                samples,
              },
              null,
              2,
            ),
          );
        }
      } finally {
        const closed = await Promise.allSettled([application.close(), hub.close()]);
        await rm(f.directory, { recursive: true, force: true });
        if (succeeded) expect(closed.filter((result) => result.status === "rejected")).toEqual([]);
      }
    }
  },
  Math.max(120_000, cycles * count * (useCli ? 3000 : 500)),
);
