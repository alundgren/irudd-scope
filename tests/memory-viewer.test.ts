import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dreaming, hash, librarianFixture, raw } from "./librarian-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
const fixture = () => librarianFixture(cleanup);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test(
  "Librarian browses a local folder without Git, searches a small result set and reads one memory",
  { tags: ["librarian-finds-memory"] },
  async () => {
    const f = await fixture();
    await f.open();
    await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
    expect(await f.page.getByRole("button", { name: "Graph", exact: true }).count()).toBe(0);
    await f.page.getByRole("textbox", { name: "Search memory", exact: true }).fill("synthetic");
    await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
    await f.page.getByRole("button", { name: "Validation", exact: true }).click();
    await f.page.locator(".memory-wiki").getByRole("heading", { name: "Validation" }).waitFor();
    const projected = await f.client.librarian({ action: "read" });
    expect(projected.state.selectedPath).toBe("validation.md");
    expect((projected.state.displayed as { raw: string }).raw).toContain("Use synthetic fixtures");
    expect(await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).count()).toBe(
      0,
    );
    expect(await readFile(join(f.root, ".git"), "utf8").catch(() => null)).toBeNull();
    for (const appearance of ["light", "dark"] as const) {
      await f.page.evaluate((appearance) => window.scope.saveSettings({ appearance }), appearance);
      await f.page.setViewportSize(
        appearance === "light" ? { width: 1280, height: 820 } : { width: 620, height: 560 },
      );
      expect(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (process.env.SCOPE_TEST_SCREENSHOTS) {
        await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
        await f.page.screenshot({
          path: join(process.env.SCOPE_TEST_SCREENSHOTS, `librarian-memory-${appearance}.png`),
        });
      }
    }
  },
);

test(
  "dreaming shows one exact human decision, records automatic work, rejects stale evidence and resumes explicitly",
  { tags: ["librarian-finds-memory"] },
  async () => {
    const f = await fixture();
    await f.open();
    await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
    const run = await dreaming(f, ["format"]);
    await run.propose("recovery.md", raw("Recovery", "Keep interrupted work."));
    await run.propose(
      "validation.md",
      raw("Validation", "Check synthetic fixtures."),
      "human",
      undefined,
      [{ path: "recovery.md", hash: hash(raw("Recovery", "Keep interrupted work.")) }],
    );
    const automated = await run.propose(
      "routine.md",
      raw("Routine", "Normalize formatting."),
      "automatic",
      "format",
    );
    expect(automated.state.pendingCount).toBe(2);
    expect(automated.state.completedCount).toBe(1);
    expect(automated.state.run!.proposals).toHaveLength(1);
    await f.page.getByRole("button", { name: "Accept proposal", exact: true }).waitFor();
    expect(await f.page.locator(".librarian-proposal").count()).toBe(1);
    expect(await f.page.getByRole("textbox", { name: "Search memory", exact: true }).count()).toBe(
      0,
    );
    expect(await f.page.getByRole("heading", { name: "Validation", exact: true }).count()).toBe(0);
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await f.page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "librarian-decision.png"),
      });
    await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
    await f.page.getByRole("heading", { name: "Validation", exact: true }).waitFor();
    await writeFile(join(f.root, "recovery.md"), "# Changed source\n");
    await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
    await f.page.getByRole("alert").filter({ hasText: "source revision changed" }).waitFor();
    expect((await f.client.librarian({ action: "read" })).state.pendingCount).toBe(1);
    const oldRevision = (await run.refresh()).state.uiRevision;
    await f.restart();
    await f.page.getByRole("heading", { name: "Validation", exact: true }).waitFor();
    const interrupted = await f.client.librarian({ action: "read" });
    expect(interrupted.state.run!.status).toBe("interrupted");
    await expect(
      f.client.librarian({
        action: "select",
        requestId: randomUUID(),
        expectedUiRevision: interrupted.state.uiRevision,
        runId: run.runId,
        capability: run.capability,
        sessionId: "existing-session",
        view: "browse",
      }),
    ).rejects.toThrow(/resume/);
    expect(interrupted.state.uiRevision).toBeGreaterThan(oldRevision);
    const resumed = await f.client.librarian({
      action: "resume",
      requestId: randomUUID(),
      expectedUiRevision: interrupted.state.uiRevision,
      runId: run.runId,
      sessionId: "resumed-session",
      userRequest: "Resume my interrupted dreaming run.",
    });
    expect(resumed.capability).toBeTruthy();
    expect(resumed.capability).not.toBe(run.capability);
    await writeFile(join(f.root, "recovery.md"), raw("Recovery", "Keep interrupted work."));
    await f.page.getByRole("button", { name: "Reject proposal", exact: true }).click();
    await f.page.getByRole("button", { name: "Inspect completed changes", exact: true }).waitFor();
    const resolved = await f.client.librarian({ action: "read" });
    const finished = await f.client.librarian({
      action: "finish",
      requestId: randomUUID(),
      expectedUiRevision: resolved.state.uiRevision,
      runId: run.runId,
      capability: resumed.capability!,
      sessionId: "resumed-session",
      userRequest: "Finish dreaming.",
    });
    expect(finished.state.run!.status).toBe("completed");
    await f.page.getByText("3 completed changes.", { exact: true }).waitFor();
    expect(await f.page.locator(".librarian-proposal").count()).toBe(0);
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await f.page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "librarian-overview.png"),
      });
    await f.page.getByRole("button", { name: "Routine", exact: true }).click();
    await f.page.getByRole("heading", { name: "Routine", exact: true }).waitFor();
    expect((await f.client.librarian({ action: "read" })).state.displayed).toMatchObject({
      change: { review: { actor: { type: "agent" } } },
    });
  },
);
