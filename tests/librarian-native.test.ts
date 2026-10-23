import { afterEach, expect, test } from "vite-plus/test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { desktopFixture } from "./desktop-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test.runIf(!!process.env.SCOPE_TEST_OKF_BINARY)(
  "Librarian uses the native OKF CLI for local init, all memory kinds and scopes, decisions and recall",
  { tags: ["librarian-finds-memory"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-native-librarian-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const executable = join(bin, process.platform === "win32" ? "irudd-okf.exe" : "irudd-okf");
    await copyFile(process.env.SCOPE_TEST_OKF_BINARY!, executable);
    await chmod(executable, 0o700);
    const root = join(directory, "memory");
    const desktop = await desktopFixture({
      hideInitialPrompts: true,
      env: {
        PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
        XDG_CONFIG_HOME: join(directory, "config"),
      },
    });
    cleanup.push(() => rm(desktop.directory, { recursive: true, force: true }));
    const application = await desktop.launch();
    cleanup.push(() => application.close());
    const page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    const client = await desktop.connect();
    await client.librarian({ action: "local", root, initialize: true });
    const manifest = JSON.parse(await readFile(join(root, "memory-bundle.json"), "utf8"));
    expect(manifest.formatVersion).toBe(2);
    expect(await readFile(join(root, ".git"), "utf8").catch(() => null)).toBeNull();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: "Librarian", exact: true }).click();
    await page.getByText("No memories found.", { exact: true }).waitFor();
    const state = (await client.librarian({ action: "read" })).state;
    const started = await client.librarian({
      action: "start",
      requestId: randomUUID(),
      expectedUiRevision: state.uiRevision,
      sessionId: "existing-native-test-session",
      userRequest: "Begin dreaming and show each proposal for my decision.",
      automaticPermissions: [],
    });
    const connection = {
      runId: started.state.run!.id,
      capability: started.capability!,
      sessionId: "existing-native-test-session",
    };
    const kinds = [
      { kind: "procedural", scope: { type: "global" }, title: "Scoped checks" },
      {
        kind: "episodic",
        scope: { type: "machine", id: "synthetic-machine" },
        title: "Interrupted task",
      },
      {
        kind: "semantic",
        scope: { type: "repository", id: "synthetic-repository" },
        title: "Repository fact",
      },
    ];
    for (const item of kinds) {
      const current = (await client.librarian({ action: "read" })).state;
      const raw = `---\ntype: Memory\ntitle: ${item.title}\nmemory: ${JSON.stringify({ id: `native-${item.kind}`, kind: item.kind, stage: "bronze", applicability: item.scope })}\n---\nA synthetic native memory about ${item.kind}.\n`;
      await client.librarian({
        action: "propose",
        requestId: randomUUID(),
        expectedUiRevision: current.uiRevision,
        ...connection,
        path: `${item.kind}.md`,
        raw,
        expectedHash: null,
        reason: "Record a checked task outcome.",
        sources: [],
        disposition: "human",
        evidence: "Synthetic task evidence.",
      });
      await page.getByRole("heading", { name: item.title, exact: true }).waitFor();
      expect(await page.locator(".librarian-proposal pre").count()).toBe(0);
      expect(await page.locator(".librarian-proposal").textContent()).not.toContain(
        "applicability",
      );
      await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
      await page
        .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
        .waitFor();
    }
    const accepted = (await client.librarian({ action: "read" })).state;
    expect(accepted.completedCount).toBe(3);
    const request = join(directory, "finish.json");
    await writeFile(
      request,
      JSON.stringify({
        action: "finish",
        requestId: randomUUID(),
        expectedUiRevision: accepted.uiRevision,
        ...connection,
        userRequest: "Finish dreaming.",
      }),
    );
    const finished = JSON.parse((await desktop.cli("librarian", "apply", request)).stdout);
    expect(finished.state.run.status).toBe("completed");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    for (const item of kinds)
      await page.getByRole("button", { name: item.title, exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "Search memory", exact: true })
      .fill("synthetic native");
    await page.getByRole("button", { name: "Search memory", exact: true }).click();
    for (const item of kinds)
      await page.getByRole("button", { name: item.title, exact: true }).waitFor();
    await page.getByRole("button", { name: "Repository fact", exact: true }).click();
    await page
      .locator(".memory-wiki")
      .getByText("A synthetic native memory about semantic.", { exact: true })
      .waitFor();
    const seen = JSON.parse((await desktop.cli("librarian", "read")).stdout);
    expect(seen.state.selectedPath).toBe("semantic.md");
    expect(seen.state.displayed.memory.applicability).toEqual({
      type: "repository",
      id: "synthetic-repository",
    });
    // The new views read real list, graph and change list output.
    const tabs = page.getByRole("tablist", { name: "Librarian views" });
    await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
    await page.getByText("No other memory links with this one.", { exact: true }).waitFor();
    await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
    await page
      .getByRole("region", { name: "Bronze", exact: true })
      .getByRole("heading", { name: "Bronze 3" })
      .waitFor();
    await tabs.getByRole("tab", { name: "Activity", exact: true }).click();
    const recorded = page.getByRole("list", { name: "Recorded changes" });
    for (const item of kinds)
      await recorded.getByRole("button", { name: `Created ${item.title}`, exact: true }).waitFor();
    await recorded.getByRole("button", { name: "Created Repository fact", exact: true }).click();
    await page
      .getByRole("region", { name: "Change", exact: true })
      .getByText("Presented for a human decision", { exact: true })
      .waitFor();
  },
);

test.runIf(!!process.env.SCOPE_TEST_OKF_BINARY)(
  "a default dreaming run over human-accepted native memories leaves only the procedure rewrite for the person",
  { tags: ["librarian-finds-memory"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-native-pile-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const executable = join(bin, process.platform === "win32" ? "irudd-okf.exe" : "irudd-okf");
    await copyFile(process.env.SCOPE_TEST_OKF_BINARY!, executable);
    await chmod(executable, 0o700);
    const root = join(directory, "memory");
    const desktop = await desktopFixture({
      hideInitialPrompts: true,
      env: {
        PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
        XDG_CONFIG_HOME: join(directory, "config"),
      },
    });
    cleanup.push(() => rm(desktop.directory, { recursive: true, force: true }));
    const application = await desktop.launch();
    cleanup.push(() => application.close());
    const page = await application.firstWindow();
    page.setDefaultTimeout(10000);
    const client = await desktop.connect();
    await client.librarian({ action: "local", root, initialize: true });
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: "Librarian", exact: true }).click();
    await page.getByText("No memories found.", { exact: true }).waitFor();
    const memory = (id: string, title: string, kind: string, body: string, stage = "bronze") =>
      `---\ntype: Memory\ntitle: ${title}\nmemory: ${JSON.stringify({ id, kind, stage, applicability: { type: "global" } })}\n---\n${body}\n`;
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const first = memory("first", "First retry", "episodic", "The deploy passed after one retry.");
    const second = memory("second", "Second retry", "episodic", "The deploy passed after a retry.");
    const steps = memory(
      "deploy",
      "Deploy steps",
      "procedural",
      "Run the deploy, then retry once.",
    );

    async function dream(sessionId: string, automaticPermissions?: string[]) {
      const state = (await client.librarian({ action: "read" })).state;
      const started = await client.librarian({
        action: "start",
        requestId: randomUUID(),
        expectedUiRevision: state.uiRevision,
        sessionId,
        userRequest: "Begin dreaming.",
        ...(automaticPermissions ? { automaticPermissions } : {}),
      });
      const connection = {
        runId: started.state.run!.id,
        capability: started.capability!,
        sessionId,
      };
      const propose = async (
        path: string,
        raw: string | null,
        disposition: "human" | "automatic",
        permission?: string,
        sources: { path: string; hash: string }[] = [],
      ) => {
        const current = (await client.librarian({ action: "read" })).state;
        const before = await readFile(join(root, path), "utf8").catch(() => null);
        return (
          await client.librarian({
            action: "propose",
            requestId: randomUUID(),
            expectedUiRevision: current.uiRevision,
            ...connection,
            path,
            raw,
            expectedHash: before === null ? null : digest(before),
            reason: `Curate ${path}`,
            sources,
            disposition,
            ...(permission ? { permission } : {}),
            evidence: `Evidence for ${path}`,
          })
        ).state;
      };
      const finish = async () => {
        const current = (await client.librarian({ action: "read" })).state;
        return client.librarian({
          action: "finish",
          requestId: randomUUID(),
          expectedUiRevision: current.uiRevision,
          ...connection,
          userRequest: "Finish dreaming.",
        });
      };
      return { propose, finish };
    }

    const seeding = await dream("seeding-session", []);
    for (const [path, raw] of [
      ["first.md", first],
      ["second.md", second],
      ["deploy.md", steps],
    ] as const) {
      await seeding.propose(path, raw, "human");
      await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
      await page
        .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
        .waitFor();
    }
    await seeding.finish();

    const curating = await dream("curating-session");
    const episodes = [
      { path: "first.md", hash: digest(first) },
      { path: "second.md", hash: digest(second) },
    ];
    const fact = memory("retry", "Deploy retries", "semantic", "Deploys can need one retry.");
    await curating.propose("retry.md", fact, "automatic", "consolidate-episodes", episodes);
    await curating.propose("first.md", null, "automatic", "consolidate-episodes");
    await curating.propose("second.md", null, "automatic", "consolidate-episodes");
    const promoted = memory(
      "deploy",
      "Deploy steps",
      "procedural",
      "Run the deploy, then retry once.",
      "silver",
    );
    let state = await curating.propose("deploy.md", promoted, "automatic", "promote-stage");
    expect(state.pendingCount).toBe(0);
    expect(state.completedCount).toBe(4);
    const rewrite = memory(
      "deploy",
      "Deploy steps",
      "procedural",
      "Run the deploy with a longer timeout.",
      "silver",
    );
    state = await curating.propose("deploy.md", rewrite, "automatic", "promote-stage");
    expect(state.pendingCount).toBe(1);
    expect(state.completedCount).toBe(4);
    await page.getByRole("heading", { name: "Deploy steps", exact: true }).waitFor();
    expect(await page.locator(".librarian-proposal").textContent()).toContain("longer timeout");
    await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
    await page
      .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
      .waitFor();
    expect((await curating.finish()).state.run!.status).toBe("completed");
    expect(await readFile(join(root, "first.md"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(root, "deploy.md"), "utf8")).toBe(promoted);
  },
);
