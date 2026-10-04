import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RetroReport, RetroSnapshot, RetroDestination } from "@irudd-scope/protocol/retro";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { desktopFixture } from "./desktop-fixture.ts";

const at = "2026-10-04T08:00:00.000Z";
const name = "synthetic-retro";
const evidence = "/tmp/scope-retro-ui-evidence";
const destination: RetroDestination = {
  id: "project-doc",
  type: "file",
  scope: "project",
  repository: "github.com/synthetic/project",
  sourceId: "local",
  path: "docs/development.md",
  available: true,
  verifiedAt: at,
};
const alternate: RetroDestination = {
  id: "personal-rule",
  type: "instructions",
  scope: "operator",
  sourceId: "local",
  path: "~/.agents/AGENTS.md",
  available: true,
  verifiedAt: at,
};
function report(count = 1): RetroReport {
  return {
    summary: "Synthetic review of retrieval and validation. No personal session data is used.",
    agent: { sourceId: "local", runtime: "codex", sessionId: "retro-agent" },
    sources: [
      {
        sourceId: "local",
        runtime: "codex",
        availability: "available",
        detail: "Synthetic fixture",
        discoveredAt: at,
        initialization: "all",
        inventoryComplete: true,
        sessionCount: count,
      },
    ],
    destinations: [destination, alternate],
    findings: [
      {
        id: "retrieval",
        category: "efficiency",
        title: "Repeated full-file reads",
        text: "Three unchanged reads repeated information already available.",
        evidence: ["Synthetic session tool records 2 through 4"],
        sessions: [{ sourceId: "local", runtime: "codex", sessionId: "session-000" }],
        proposal: {
          kind: "correction",
          destination,
          text: "Read the relevant range after the initial inspection.",
        },
      },
    ],
    metrics: [
      {
        name: "Repeated reads",
        unit: "calls",
        certainty: "exact",
        value: 3,
        evidence: "Tool records 2 through 4",
        method: "Count matching read commands",
        coverage: "One synthetic session",
      },
      {
        name: "Cost",
        unit: "USD",
        certainty: "unknown",
        value: null,
        evidence: "No pricing metadata",
        method: "No cost was inferred",
        coverage: "Synthetic logs",
      },
    ],
  };
}
async function read(client: ScopeClient) {
  const reply = await client.retro({ action: "read", name });
  if (reply.type !== "snapshot") throw new Error("Expected RETRO snapshot.");
  return reply.snapshot;
}
async function configure(client: ScopeClient) {
  const settings = await client.retro({ action: "settings" });
  if (settings.type !== "configuration") throw new Error("Expected configuration.");
  await client.retro({
    action: "configure",
    requestId: randomUUID(),
    expectedVersion: settings.configuration.version,
    configuration: {
      ...settings.configuration,
      sources: [
        {
          id: "local",
          name: "This Mac",
          sshAlias: null,
          included: true,
          runtimes: ["codex"],
          runtimeRoots: { codex: null, claude: null },
        },
      ],
      repositories: [{ repository: "github.com/synthetic/project", included: true }],
      memory: { enabled: false, destinations: [] },
    },
  });
}
async function publishReport(client: ScopeClient, count = 1, value = report(count)) {
  let snapshot = await read(client);
  await client.retro({
    action: "publish",
    name,
    tabId: snapshot.tabId,
    requestId: randomUUID(),
    expectedVersion: snapshot.version,
    report: value,
  });
  for (let start = 0; start < count; start += 200) {
    snapshot = await read(client);
    await client.retro({
      action: "inventory",
      name,
      tabId: snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: snapshot.version,
      sessions: Array.from({ length: Math.min(200, count - start) }, (_, offset) => ({
        sourceId: "local",
        runtime: "codex" as const,
        sessionId: `session-${String(start + offset).padStart(3, "0")}`,
        repository: "github.com/synthetic/project",
        startedAt: "2026-10-03T08:00:00.000Z",
        lastActivityAt: "2026-10-03T09:00:00.000Z",
        status: "reviewed" as const,
        evidence: "Synthetic session records",
      })),
    });
  }
}
type SDK = {
  watch: (callback: (value: RetroSnapshot) => void) => () => void;
  state: {
    read: () => Promise<{ version: number; value: Record<string, unknown> }>;
    patch: (value: Record<string, unknown>, version: number) => Promise<unknown>;
  };
  history: {
    list: () => Promise<{ type: "history"; entries: { tabId: string }[] }>;
    open: (tabId: string) => Promise<unknown>;
  };
  finish?: unknown;
  beforeClose: (callback: () => Promise<void>) => () => void;
};

test("RETRO preserves drafts through data updates, HTML replacement, navigation, restart, and completed history", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    await mkdir(evidence, { recursive: true });
    let page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const file = join(fixture.directory, "report.html");
    const html = await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8");
    await writeFile(file, html);
    await fixture.cli(
      "add",
      file,
      "--retro",
      "--name",
      name,
      "--title",
      "Retrieval and checks across several long synthetic project names",
    );
    let client = await fixture.connect();
    await configure(client);
    await publishReport(client);
    let frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    expect(
      (await page.evaluate(() => window.scope.retainedTabs())).find(
        (entry) => entry.tab.type === "retro",
      )?.permanent,
    ).toBe(true);
    const state = await frame
      .locator("body")
      .evaluate(async () =>
        (window as unknown as { scope: { retros: SDK } }).scope.retros.state.read(),
      );
    expect(state).toEqual({ version: 0, value: {} });
    expect(
      await frame
        .locator("body")
        .evaluate(() => "finish" in (window as unknown as { scope: { retros: SDK } }).scope.retros),
    ).toBe(false);
    await page.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await page.getByText("Agent request copied.", { exact: true }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "irudd-scope retro read synthetic-retro",
    );
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Keep this draft while the agent investigates.");
    const current = await read(client);
    await client.retro({
      action: "comment",
      name,
      tabId: current.tabId,
      requestId: randomUUID(),
      expectedVersion: current.version,
      findingId: "retrieval",
      text: "An agent update should preserve the human input.",
    });
    await frame
      .getByText("An agent update should preserve the human input.", { exact: true })
      .waitFor();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this draft while the agent investigates.",
    );
    await writeFile(
      file,
      html.replace("<h1>Session retrospective</h1>", "<h1>Updated session retrospective</h1>"),
    );
    await fixture.cli("update", name, file);
    await frame.getByRole("heading", { name: "Updated session retrospective" }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this draft while the agent investigates.",
    );
    const otherFile = join(fixture.directory, "other.html");
    await writeFile(otherFile, "<!doctype html><h1>Other report content</h1>");
    await fixture.cli("add", otherFile, "--title", "Other report");
    await page.getByRole("tab", { name: "Other report", exact: true }).click();
    await page
      .frameLocator('iframe[title="Other report"]')
      .getByRole("heading", { name: "Other report content" })
      .waitFor();
    await page
      .getByRole("tab", {
        name: "Retrieval and checks across several long synthetic project names",
        exact: true,
      })
      .click();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this draft while the agent investigates.",
    );
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    client = await fixture.connect();
    frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this draft while the agent investigates.",
    );
    await frame.getByRole("button", { name: "Save comment", exact: true }).click();
    await frame
      .getByText("Keep this draft while the agent investigates.", { exact: true })
      .waitFor();
    await frame.getByRole("button", { name: "Edit proposal", exact: true }).click();
    await frame.getByRole("button", { name: "Ask agent to investigate", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Investigation request", exact: true })
      .fill("Check whether the repeated reads added new evidence.");
    await frame.getByRole("button", { name: "Send request", exact: true }).click();
    await expect.poll(async () => (await read(client)).requests[0]?.status).toBe("pending");
    const investigation = await read(client);
    await client.retro({
      action: "resolve-request",
      name,
      tabId: investigation.tabId,
      requestId: randomUUID(),
      expectedVersion: investigation.version,
      id: investigation.requests[0].id,
      status: "answered",
      response: "The synthetic reads repeat unchanged content.",
    });
    await frame.getByText(/The synthetic reads repeat unchanged content/).waitFor();
    await frame.getByRole("button", { name: "Reject", exact: true }).click();
    await expect.poll(async () => (await read(client)).decisions[0]?.decision).toBe("reject");
    await frame.getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(async () => (await read(client)).decisions[0]?.decision).toBe("accept");
    await frame.getByRole("button", { name: "Edit proposal", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Proposed text" })
      .fill("Use a targeted read and explain the result first.");
    await frame.getByLabel("Destination and scope").selectOption("personal-rule");
    await frame.getByRole("button", { name: "Save edited proposal" }).click();
    await expect
      .poll(async () => (await read(client)).decisions[0]?.destination?.id)
      .toBe("personal-rule");
    await frame
      .getByRole("button", { name: "Save edited proposal" })
      .waitFor({ state: "detached" });
    let updated = await read(client);
    await client.retro({
      action: "outcomes",
      name,
      tabId: updated.tabId,
      requestId: randomUUID(),
      expectedVersion: updated.version,
      outcomes: [
        {
          findingId: "retrieval",
          status: "declined",
          evidence: "Synthetic test deliberately makes no filesystem edits.",
        },
      ],
    });
    await page.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await expect.poll(async () => (await read(client)).appState.value.drafts).toEqual({});
    updated = await read(client);
    await client.retro({
      action: "finish",
      name,
      tabId: updated.tabId,
      requestId: randomUUID(),
      expectedVersion: updated.version,
      operatorInstruction: "Finish this synthetic test report.",
    });
    await page.getByText("Saved final report · Read only", { exact: true }).waitFor();
    expect(await frame.getByRole("button", { name: "Accept", exact: true }).isDisabled()).toBe(
      true,
    );
    expect(
      await page.getByRole("button", { name: "Copy agent request", exact: true }).count(),
    ).toBe(0);
    const historyFromSDK = await frame.locator("body").evaluate(async () => {
      const sdk = (window as unknown as { scope: { retros: SDK } }).scope.retros;
      const history = await sdk.history.list();
      await sdk.history.open(history.entries[0].tabId);
      return history;
    });
    expect(historyFromSDK.entries[0].tabId).toBe(updated.tabId);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((appearance) => window.scope.saveSettings({ appearance }), theme);
      await page.evaluate((appearance) => {
        document.documentElement.dataset.theme = appearance;
      }, theme);
      await page.setViewportSize(
        theme === "light" ? { width: 1280, height: 820 } : { width: 600, height: 640 },
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await page.screenshot({ path: join(evidence, `finished-${theme}.png`) });
    }
    await page
      .getByRole("button", {
        name: "Close Retrieval and checks across several long synthetic project names",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Other report", exact: true }).waitFor();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro history");
    await settings.getByRole("button", { name: "Open retrospective history", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Retrospective history", exact: true });
    await history.getByRole("button", { name: "Open report" }).click();
    await history.waitFor({ state: "hidden" });
    await page.getByText("Saved final report · Read only", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("an investigation can add a proposal to the same finding without replacing its draft editor", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const file = join(fixture.directory, "report.html");
    await writeFile(file, await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8"));
    await fixture.cli("add", file, "--retro", "--name", name);
    const client = await fixture.connect();
    await configure(client);
    const initial = report();
    await publishReport(client, 1, {
      ...initial,
      findings: initial.findings.map(({ proposal: _proposal, ...finding }) => finding),
    });
    const frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    expect(await frame.getByRole("button", { name: "Accept", exact: true }).isDisabled()).toBe(
      true,
    );
    await frame.getByRole("button", { name: "Ask agent to investigate", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Investigation request", exact: true })
      .fill("Find a concrete correction for this repeated retrieval.");
    await frame.getByRole("button", { name: "Send request", exact: true }).click();
    await expect.poll(async () => (await read(client)).requests[0]?.status).toBe("pending");
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    const input = frame.getByRole("textbox", { name: "Comment", exact: true });
    await input.fill("Keep my draft while the agent proposes a correction.");
    const current = await read(client);
    await client.retro({
      action: "publish",
      name,
      tabId: current.tabId,
      requestId: randomUUID(),
      expectedVersion: current.version,
      report: report(),
    });
    await expect
      .poll(() => frame.getByRole("button", { name: "Accept", exact: true }).isEnabled())
      .toBe(true);
    expect(await input.inputValue()).toBe("Keep my draft while the agent proposes a correction.");
    await frame.getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(async () => (await read(client)).decisions[0]?.decision).toBe("accept");
    expect(await input.inputValue()).toBe("Keep my draft while the agent proposes a correction.");
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("finishing an unvisited report does not flush another report's failing pending input", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const file = join(fixture.directory, "report.html");
    const html = await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8");
    await writeFile(
      file,
      html.replace(
        "<head>",
        `<head><script>
      window.syntheticUnrelatedSave = window.scope.retros.beforeClose(async () => {
        throw new Error("Unrelated report is still being edited.");
      });
    </script>`,
      ),
    );
    await fixture.cli("add", file, "--retro", "--name", name);
    const client = await fixture.connect();
    await configure(client);
    await publishReport(client);
    const frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("Keep this other report's input pending.");
    const otherName = "unvisited-retro";
    await fixture.cli("add", file, "--retro", "--name", otherName, "--title", "Unvisited report");
    await page.getByRole("tab", { name: "Unvisited report", exact: true }).waitFor();
    expect(await page.locator(".retro-document").count()).toBe(1);
    let other = await client.retro({ action: "read", name: otherName });
    if (other.type !== "snapshot") throw new Error("Expected snapshot.");
    await client.retro({
      action: "publish",
      name: otherName,
      tabId: other.snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: other.snapshot.version,
      report: {
        ...report(0),
        agent: { sourceId: "local", runtime: "codex", sessionId: "other-retro-agent" },
        findings: [],
        destinations: [],
      },
    });
    other = await client.retro({ action: "read", name: otherName });
    if (other.type !== "snapshot") throw new Error("Expected snapshot.");
    await client.retro({
      action: "finish",
      name: otherName,
      tabId: other.snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: other.snapshot.version,
      operatorInstruction: "Finish this unvisited synthetic report.",
    });
    other = await client.retro({ action: "read", name: otherName });
    if (other.type !== "snapshot") throw new Error("Expected snapshot.");
    expect(other.snapshot.status).toBe("finished");
    expect((await read(client)).appState).toEqual({ version: 0, value: {} });
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "Keep this other report's input pending.",
    );
  } finally {
    const page = await application.firstWindow();
    await page
      .frameLocator(".retro-document")
      .locator("body")
      .evaluate(() => {
        (window as unknown as { syntheticUnrelatedSave: () => void }).syntheticUnrelatedSave();
      });
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("finish saves unsent drafts and failed report flushes leave audit markers unchanged", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const file = join(fixture.directory, "report.html");
    await writeFile(file, await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8"));
    await fixture.cli(
      "add",
      file,
      "--retro",
      "--name",
      "earlier-retro",
      "--title",
      "Earlier report",
    );
    await page
      .frameLocator('iframe[title="Earlier report"]')
      .getByRole("heading", { name: "Session retrospective", exact: true })
      .waitFor();
    await fixture.cli("add", file, "--retro", "--name", name, "--title", "Target report");
    const client = await fixture.connect();
    await configure(client);
    await publishReport(client);
    await page.getByRole("tab", { name: "Target report", exact: true }).click();
    const frame = page.frameLocator('iframe[title="Target report"]');
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("My unsent final note.");
    async function finish() {
      const current = await read(client);
      return client.retro({
        action: "finish",
        name,
        tabId: current.tabId,
        requestId: randomUUID(),
        expectedVersion: current.version,
        operatorInstruction: "Finish after retaining this draft for reference.",
      });
    }
    await expect(finish()).rejects.toThrow(/changed/i);
    let current = await read(client);
    expect(current.status).toBe("active");
    expect(current.appState.value.drafts).toEqual({ "retrieval:comment": "My unsent final note." });
    await frame.locator("body").evaluate(() => {
      const sdk = (window as unknown as { scope: { retros: SDK } }).scope.retros;
      Object.assign(window, {
        syntheticRetroCloseFailure: sdk.beforeClose(async () => {
          throw new Error("Synthetic draft failure.");
        }),
      });
    });
    await expect(finish()).rejects.toThrow(/Synthetic draft failure/i);
    current = await read(client);
    expect(current.status).toBe("active");
    const tracking = await client.retro({
      action: "tracking",
      sourceId: "local",
      runtime: "codex",
    });
    if (tracking.type !== "tracking") throw new Error("Expected tracking.");
    expect(tracking.initialized).toBe(false);
    expect(tracking.audited).toEqual([]);
    await frame
      .locator("body")
      .evaluate(() =>
        (
          window as unknown as { syntheticRetroCloseFailure: () => void }
        ).syntheticRetroCloseFailure(),
      );
    await finish();
    await page.getByText("Saved final report · Read only", { exact: true }).waitFor();
    await frame.getByRole("heading", { name: "Unsent drafts", exact: true }).waitFor();
    await frame.getByText("My unsent final note.", { exact: true }).waitFor();
    current = await read(client);
    expect(current.comments).toEqual([]);
    expect(current.requests).toEqual([]);
    expect(current.appState.value.drafts).toEqual({ "retrieval:comment": "My unsent final note." });
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, "finished-unsent-draft.png") });
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("typing during a pending comment and draft save retains the newer input", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    const file = join(fixture.directory, "report.html");
    await writeFile(file, await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8"));
    await fixture.cli("add", file, "--retro", "--name", name);
    const client = await fixture.connect();
    await configure(client);
    await publishReport(client);
    const frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await application.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
        }
      )._invokeHandlers;
      const original = handlers.get("scope:retro-command");
      if (!original) throw new Error("Expected RETRO IPC handler.");
      const waiting = new Map<string, () => void>();
      const delayed = new Set(["comment", "state-patch"]);
      Object.assign(globalThis, { syntheticRetroWrites: waiting });
      ipcMain.removeHandler("scope:retro-command");
      ipcMain.handle("scope:retro-command", async (event, command) => {
        if (delayed.delete(command.action))
          await new Promise<void>((resolve) => waiting.set(command.action, resolve));
        return original(event, command);
      });
    });
    async function waiting(action: string) {
      return application.evaluate((_electron, name) => {
        const pending = (
          globalThis as unknown as {
            syntheticRetroWrites: Map<string, () => void>;
          }
        ).syntheticRetroWrites;
        return pending.has(name);
      }, action);
    }
    async function release(action: string) {
      await application.evaluate((_electron, name) => {
        const pending = (
          globalThis as unknown as {
            syntheticRetroWrites: Map<string, () => void>;
          }
        ).syntheticRetroWrites;
        pending.get(name)?.();
        pending.delete(name);
      }, action);
    }
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    const input = frame.getByRole("textbox", { name: "Comment", exact: true });
    await input.fill("Submitted comment.");
    await frame.getByRole("button", { name: "Save comment", exact: true }).click();
    await expect.poll(() => waiting("comment")).toBe(true);
    await input.fill("New draft while the comment is pending.");
    await release("comment");
    await expect
      .poll(async () => (await read(client)).comments.map((entry) => entry.text))
      .toEqual(["Submitted comment."]);
    expect(await input.inputValue()).toBe("New draft while the comment is pending.");
    await page.getByRole("button", { name: "Copy agent request", exact: true }).click();
    await expect.poll(() => waiting("state-patch")).toBe(true);
    await input.fill("Newest input while the draft save is pending.");
    await release("state-patch");
    await page.getByText("Agent request copied.", { exact: true }).waitFor();
    expect((await read(client)).appState.value.drafts).toEqual({
      "retrieval:comment": "Newest input while the draft save is pending.",
    });
    expect(await input.inputValue()).toBe("Newest input while the draft save is pending.");
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("a changed saved draft blocks HTML replacement until the human resolves it, and read errors keep the mounted report", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    let page = await application.firstWindow();
    const file = join(fixture.directory, "report.html");
    const html = await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8");
    await writeFile(file, html);
    await fixture.cli("add", file, "--retro", "--name", name);
    let client = await fixture.connect();
    await configure(client);
    await publishReport(client);
    let frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    await frame
      .getByRole("textbox", { name: "Comment", exact: true })
      .fill("My unsaved note stays here.");
    let current = await read(client);
    await client.retro({
      action: "state-patch",
      name,
      tabId: current.tabId,
      requestId: randomUUID(),
      expectedVersion: current.appState.version,
      value: { drafts: { "retrieval:comment": "A concurrently saved draft" } },
    });
    await frame.getByRole("button", { name: "Keep my current draft", exact: true }).waitFor();
    await writeFile(
      file,
      html.replace("<h1>Session retrospective</h1>", "<h1>Replacement report</h1>"),
    );
    await fixture.cli("update", name, file);
    await page
      .getByRole("alert")
      .filter({ hasText: /version|changed|conflict/i })
      .waitFor();
    expect(
      await frame.getByRole("heading", { name: "Session retrospective", exact: true }).count(),
    ).toBe(1);
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "My unsaved note stays here.",
    );
    await page.screenshot({ path: join(evidence, "draft-conflict-light.png") });
    await frame.getByRole("button", { name: "Keep my current draft", exact: true }).click();
    await expect
      .poll(async () => (await read(client)).appState.value.drafts)
      .toEqual({ "retrieval:comment": "My unsaved note stays here." });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await frame.getByRole("heading", { name: "Replacement report", exact: true }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "My unsaved note stays here.",
    );
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("scope:retro-command");
      ipcMain.handle("scope:retro-command", () => {
        throw new Error("Synthetic connection unavailable.");
      });
    });
    current = await read(client);
    await client.retro({
      action: "comment",
      name,
      tabId: current.tabId,
      requestId: randomUUID(),
      expectedVersion: current.version,
      findingId: "retrieval",
      text: "The read will recover after restart.",
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "Synthetic connection unavailable." })
      .waitFor();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "My unsaved note stays here.",
    );
    await page.screenshot({ path: join(evidence, "read-error-light.png") });
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    client = await fixture.connect();
    frame = page.frameLocator(".retro-document");
    await frame.getByText("The read will recover after restart.", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Comment", exact: true }).click();
    expect(await frame.getByRole("textbox", { name: "Comment", exact: true }).inputValue()).toBe(
      "My unsaved note stays here.",
    );
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("RETRO watch assembles a multi-page inventory and history opens from searchable settings", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByLabel("Search settings").fill("retro history");
    await settings.getByRole("button", { name: "Open retrospective history" }).click();
    const history = page.getByRole("dialog", { name: "Retrospective history", exact: true });
    await history
      .getByText("No completed retros yet. Ask your coding agent for a Scope retro.")
      .waitFor();
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    const file = join(fixture.directory, "report.html");
    await writeFile(file, await readFile("apps/desktop/src/plugins/retro/starter.html", "utf8"));
    await fixture.cli("add", file, "--retro", "--name", name);
    const client = await fixture.connect();
    await configure(client);
    await publishReport(client, 205);
    const frame = page.frameLocator(".retro-document");
    await frame.getByRole("heading", { name: "Repeated full-file reads" }).waitFor();
    await expect
      .poll(() =>
        frame.locator("body").evaluate(
          () =>
            new Promise<number>((resolve) => {
              const sdk = (window as unknown as { scope: { retros: SDK } }).scope.retros;
              let stop: (() => void) | undefined;
              stop = sdk.watch((value) => resolve(value.sessions.length));
              stop();
            }),
        ),
      )
      .toBe(205);
    const current = await read(client);
    await client.retro({
      action: "finish",
      name,
      tabId: current.tabId,
      requestId: randomUUID(),
      expectedVersion: current.version,
      operatorInstruction: "Finish the paginated synthetic review.",
    });
    await page.getByText("Saved final report · Read only", { exact: true }).waitFor();
    await page.keyboard.press("ControlOrMeta+,");
    await settings.getByLabel("Search settings").fill("retro history");
    await settings.getByRole("button", { name: "Open retrospective history" }).click();
    await history.getByRole("button", { name: "Open report" }).click();
    await settings.waitFor({ state: "hidden" });
    await page.getByText("Saved final report · Read only", { exact: true }).waitFor();
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);
