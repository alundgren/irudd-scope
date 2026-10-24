import { expect } from "vite-plus/test";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { folderNetwork } from "./guest-folder-network.ts";

/** Recovery cannot disappear while a request can still write or before a new inspection decision. */
export async function guestFolderRecoveryChecks(input: {
  page: Page;
  tabId: string;
  root: string;
  directory: string;
  proxy: Awaited<ReturnType<typeof folderNetwork>>;
  prepare: (
    page: Page,
    tabId: string,
    paths: string[],
  ) => Promise<{ status: string; planId?: string }>;
  restart: () => Promise<Page>;
  reconnect: () => Promise<unknown>;
  capture: (name: string) => Promise<void>;
  resize: (width: number) => Promise<void>;
}) {
  let page = input.page;
  const { tabId, proxy } = input;
  const failures: string[] = [];
  const saved = () => page.evaluate((id) => window.scope.guestFolderRecovery(id), tabId);
  const panel = () => page.locator(`#pane-${tabId} .guest-folder-recovery`);
  for (const kind of ["file", "directory"] as const) {
    const path = `delayed-${kind}`;
    const original = join(input.directory, path);
    await writeFile(original, "recoverable input");
    const plan = kind === "file" ? await input.prepare(page, tabId, [original]) : undefined;
    const gate = proxy.delayNextVersion();
    proxy.drop();
    const executing = page.evaluate(
      async ({ tabId, kind, path, planId }) => {
        try {
          if (kind === "file")
            return await window.scope.startFolderDrop({ planId: planId!, choices: {} });
          await window.scope.createFolderDirectory({ tabId, path });
          return {};
        } catch (error) {
          return { failed: String(error) };
        }
      },
      { tabId, kind, path, planId: plan?.planId },
    );
    let before: Awaited<ReturnType<typeof saved>>;
    try {
      await gate.entered;
      await page.evaluate((id) => window.scope.guestFolderStatus(id), tabId);
      before = await saved();
      expect(before?.outcome?.state).toBe("unknown");
      await panel()
        .getByText(/Outcome unknown/)
        .waitFor();
      const clear = panel().getByRole("button", {
        name: "I checked the destination; clear recovery",
      });
      if (await clear.count()) {
        await clear.click();
        await expect.poll(saved).toBeUndefined();
        failures.push(`${kind}: UI allowed recovery clear while owner preflight was delayed`);
      } else {
        const error = await page.evaluate(
          async (request) => {
            try {
              await window.scope.guestFolderRelease(request);
              return "cleared";
            } catch (error) {
              return String(error);
            }
          },
          {
            tabId,
            requestId: before!.write.operation.requestId,
            acknowledgedOutcome: before!.outcome,
          },
        );
        expect(error).toMatch(/still running/);
        expect((await saved())?.write.operation.requestId).toBe(before!.write.operation.requestId);
      }
      if (kind === "file") await input.capture("guest-folder-active-recovery.png");
    } finally {
      gate.release();
    }
    expect((await executing).failed).toBeTruthy();
    await expect.poll(() => readdir(input.root)).toContain(path);
    page = await input.restart();
    const recovered = await saved();
    if (recovered?.write.operation.requestId !== before!.write.operation.requestId)
      failures.push(
        `${kind}: lost reply and receiver restart lost the original operation identity`,
      );
    if (kind === "file") {
      expect(await readFile(original, "utf8")).toBe("recoverable input");
      if (recovered?.original?.path !== original)
        failures.push("file: restart lost original upload reference");
    }
    await input.reconnect();
    if (recovered) {
      await panel().getByRole("button", { name: "Check upload status", exact: true }).click();
      await panel().getByRole("button", { name: "Refresh folder and clear recovery" }).click();
      await expect.poll(saved).toBeUndefined();
    }
  }
  const knownFile = join(input.directory, "known-result.txt");
  await writeFile(knownFile, "replacement");
  await writeFile(join(input.root, "known-result.txt"), "before consent");
  const knownPlan = await input.prepare(page, tabId, [knownFile]);
  await writeFile(join(input.root, "known-result.txt"), "changed after consent");
  await page.evaluate(
    (planId) => window.scope.startFolderDrop({ planId: planId!, choices: { "0": "replace" } }),
    knownPlan.planId,
  );
  expect((await saved())?.outcome?.state).toBe("failed");
  proxy.expireStatus(true);
  try {
    await panel().getByRole("button", { name: "Refresh folder and clear recovery" }).click();
    await expect
      .poll(async () => {
        const value = await saved();
        return (
          !value ||
          (value.outcome?.state === "expired" &&
            (await panel().getByRole("button", { name: "Checking…", exact: true }).count()) === 0)
        );
      })
      .toBe(true);
    const refreshed = await saved();
    if (!refreshed)
      failures.push(
        "known-to-expired: normal clear discarded fresh uncertainty without inspection",
      );
    else {
      expect(refreshed.outcome?.state).toBe("expired");
      for (const appearance of ["light", "dark"] as const) {
        await page.getByRole("button", { name: "Search and controls" }).click();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByLabel("Search settings").fill("appearance");
        await page.getByLabel("Appearance", { exact: true }).selectOption(appearance);
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .click();
        for (const [label, width] of [
          ["laptop", 1366],
          ["narrow", 620],
        ] as const) {
          await input.resize(width);
          await input.capture(`guest-folder-expired-${appearance}-${label}.png`);
        }
      }
      const listing = proxy.delayNextList();
      try {
        await panel()
          .getByRole("button", { name: "I checked the destination; clear recovery" })
          .click();
        await listing.entered;
        const concurrent = await page.evaluate(
          (tabId) =>
            window.scope.createFolderDirectory({ tabId, path: "during-release" }).then(
              () => "created",
              (error) => String(error),
            ),
          tabId,
        );
        expect(concurrent).toMatch(/still running/);
        expect((await saved())?.write.operation.requestId).toBe(
          refreshed.write.operation.requestId,
        );
      } finally {
        listing.release();
      }
      await expect.poll(saved).toBeUndefined();
      expect(await readdir(input.root)).not.toContain("during-release");
    }
  } finally {
    proxy.expireStatus(false);
  }
  expect(failures).toEqual([]);
}
