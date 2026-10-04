import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { type Artifact } from "@irudd-scope/protocol";
import {
  canonicalRetroRepository,
  type RetroCommand,
  type RetroConfiguration,
  type RetroDestination,
  type RetroReport,
  type RetroSession,
} from "@irudd-scope/protocol/retro";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { startHub } from "../apps/hub/src/server.ts";

const token = "synthetic-retrospective-test-token";
const cutoff = "2026-10-04T08:00:00.000Z";
const repository = "github.com/operator/project";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const exec = promisify(execFile);
const destination: RetroDestination = {
  id: "project-instructions",
  type: "instructions",
  scope: "project",
  repository,
  sourceId: "local",
  path: "/synthetic/AGENTS.md",
  available: true,
  verifiedAt: cutoff,
};
const configuration = (
  runtimes: ReadonlyArray<"codex" | "claude"> = ["codex"],
): RetroConfiguration => ({
  version: 0,
  sources: [
    {
      id: "local",
      name: "Local",
      sshAlias: null,
      included: true,
      runtimes,
      runtimeRoots: { codex: null, claude: null },
    },
  ],
  repositories: [{ repository, included: true }],
  memory: { enabled: false, destinations: [destination] },
});
const report = (initialization: "all" | "from-now" | "none" = "all", count = 0): RetroReport => ({
  destinations: [],
  summary: "Reviewed synthetic sessions",
  agent: { sourceId: "local", runtime: "codex", sessionId: "retro-agent" },
  sources: [
    {
      sourceId: "local",
      runtime: "codex",
      availability: "available",
      discoveredAt: cutoff,
      initialization,
      detail: "Complete synthetic discovery",
      inventoryComplete: true,
      sessionCount: count,
    },
  ],
  findings: [],
  metrics: [
    {
      name: "tokens",
      unit: "tokens",
      certainty: "unknown",
      value: null,
      evidence: "Native usage unavailable",
      method: "Native metadata",
      coverage: "Selected sessions",
    },
  ],
});
const session = (id: string, status: RetroSession["status"] = "reviewed"): RetroSession => ({
  sourceId: "local",
  runtime: "codex",
  sessionId: id,
  repository,
  startedAt: "2026-10-03T08:00:00.000Z",
  lastActivityAt: "2026-10-03T09:00:00.000Z",
  status,
  evidence: "Readable synthetic native history",
});
const metadata = (artifact: Artifact) => ({
  name: artifact.name,
  title: artifact.title,
  kind: artifact.kind,
  mediaType: artifact.mediaType,
  fileName: artifact.fileName,
  ...(artifact.source ? { source: artifact.source } : {}),
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-retro-api-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const desktop = new DesktopStore(join(directory, "desktop"));
  await desktop.load();
  cleanup.push(() => desktop.close());
  const retroConfiguration = {
    read: () => desktop.retroConfiguration(),
    configure: (command: Extract<RetroCommand, { action: "configure" }>) =>
      desktop.saveRetroConfiguration(command),
  };
  let server = await startArtifactServer({ directory, token, port: 0, retroConfiguration });
  cleanup.push(() => server.close());
  let client = new ScopeClient(server.url, token);
  async function restart() {
    await server.close();
    server = await startArtifactServer({ directory, token, port: 0, retroConfiguration });
    client = new ScopeClient(server.url, token);
    return client;
  }
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
      maxBuffer: 5 * 1024 * 1024,
    });
  async function configure(value = configuration()) {
    return client.retro({
      action: "configure",
      requestId: randomUUID(),
      expectedVersion: value.version,
      configuration: value,
    });
  }
  async function create(name = "test-retro", html = "<h1>Synthetic review</h1>") {
    const artifact = await client.publish(
      randomUUID(),
      {
        name,
        title: name,
        kind: "retro",
        mediaType: "text/html",
        fileName: "retro.html",
        expectedRevision: 0,
      },
      Buffer.from(html),
    );
    const snapshot = await read(name);
    return { artifact, tabId: snapshot.tabId, name };
  }
  async function read(name = "test-retro") {
    const reply = await client.retro({ action: "read", name });
    if (reply.type !== "snapshot") throw new Error("Expected snapshot");
    return reply.snapshot;
  }
  async function write(
    owner: { name: string; tabId: string },
    command:
      | Omit<
          Extract<RetroCommand, { name: string; requestId: string }>,
          "name" | "tabId" | "expectedVersion" | "requestId"
        >
      | Record<string, unknown>,
  ) {
    const current = await read(owner.name);
    return client.retro({
      ...command,
      name: owner.name,
      tabId: owner.tabId,
      expectedVersion: command.action?.toString().startsWith("state-")
        ? current.appState.version
        : current.version,
      requestId: randomUUID(),
    } as RetroCommand);
  }
  return {
    directory,
    desktop,
    get server() {
      return server;
    },
    get client() {
      return client;
    },
    restart,
    cli,
    configure,
    create,
    read,
    write,
  };
}

test("finish persists frozen history, initialization and exact reviewed IDs after restart and deletion", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report("all", 3) });
  await f.write(owner, {
    action: "inventory",
    sessions: [session("reviewed"), session("failed", "failed"), session("ignored", "ignored")],
  });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: false, audited: [], agents: ["retro-agent"] });
  const before = await f.read();
  const finish: RetroCommand = {
    action: "finish",
    name: owner.name,
    tabId: owner.tabId,
    expectedVersion: before.version,
    requestId: randomUUID(),
    operatorInstruction: "Please finish this retrospective.",
  };
  const receipt = await f.client.retro(finish);
  expect(await f.client.retro(finish)).toEqual(receipt);
  await f.restart();
  const saved = await f.read();
  expect(saved.status).toBe("finished");
  expect(saved.sessions.map((s) => s.sessionId)).toEqual(["failed", "ignored", "reviewed"]);
  expect(Buffer.from(await f.client.content(owner.artifact.id, owner.artifact.revision))).toEqual(
    Buffer.from("<h1>Synthetic review</h1>"),
  );
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({
    initialized: true,
    mode: "all",
    audited: ["reviewed"],
    agents: ["retro-agent"],
  });
  await expect(
    f.write(owner, { action: "comment", findingId: null, text: "Cannot mutate" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.client.publish(
      owner.artifact.id,
      { ...metadata(owner.artifact), expectedRevision: owner.artifact.revision },
      Buffer.from("Changed"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await f.client.delete(owner.artifact.id);
  expect(await f.client.retro({ action: "history" })).toMatchObject({ entries: [] });
  await expect(f.client.retro(finish)).rejects.toMatchObject({ status: 404 });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: true, audited: ["reviewed"] });
  expect(await f.client.retro({ action: "settings" })).toMatchObject({
    configuration: { sources: [{ id: "local" }] },
  });
});

test.each(["all", "from-now"] as const)(
  "empty %s initialization commits only at finish",
  async (mode) => {
    const f = await fixture();
    await f.configure();
    const owner = await f.create();
    await f.write(owner, { action: "publish", report: report(mode) });
    expect(
      await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
    ).toMatchObject({ initialized: false });
    await f.restart();
    expect((await f.read()).status).toBe("active");
    await f.write(owner, { action: "finish", operatorInstruction: "Finish empty setup." });
    expect(
      await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
    ).toMatchObject({ initialized: true, mode, cutoff, audited: [] });
  },
);

test("incomplete pages and check-only coverage cannot initialize, unavailable override leaves only available runtime initialized", async () => {
  const f = await fixture();
  await f.configure(configuration(["codex", "claude"]));
  const owner = await f.create();
  const partial = {
    ...report("all", 1),
    sources: [
      { ...report().sources[0], sessionCount: 1, inventoryComplete: false },
      {
        sourceId: "local",
        runtime: "claude",
        availability: "unavailable",
        discoveredAt: cutoff,
        initialization: "none",
        detail: "SSH unavailable",
        inventoryComplete: false,
        sessionCount: 0,
      },
    ],
  } as RetroReport;
  await f.write(owner, { action: "publish", report: partial });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: false });
  await f.write(owner, { action: "inventory", sessions: [session("one")] });
  const complete = {
    ...partial,
    sources: partial.sources.map((s) =>
      s.runtime === "codex" ? { ...s, inventoryComplete: true } : s,
    ),
  };
  await f.write(owner, { action: "publish", report: complete });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409 });
  await f.write(owner, {
    action: "publish",
    report: {
      ...complete,
      sources: complete.sources.map((s) =>
        s.runtime === "claude"
          ? { ...s, override: "Operator: proceed without Claude, review it later." }
          : s,
      ),
    },
  });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish available source" });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: true, audited: ["one"] });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "claude" }),
  ).toMatchObject({ initialized: false, audited: [] });
});

test("current and prior retro agents, audited resumed IDs and Start now unknown dates cannot be re-audited", async () => {
  const f = await fixture();
  await f.configure();
  const first = await f.create();
  await f.write(first, { action: "publish", report: report("all", 1) });
  await expect(
    f.write(first, { action: "inventory", sessions: [session("retro-agent")] }),
  ).rejects.toMatchObject({ status: 400 });
  await f.write(first, { action: "inventory", sessions: [session("reviewed")] });
  await f.write(first, { action: "finish", operatorInstruction: "Finish" });
  const second = await f.create("next-retro");
  await f.write(second, {
    action: "publish",
    report: {
      ...report("none", 0),
      agent: { sourceId: "local", runtime: "codex", sessionId: "second-agent" },
    },
  });
  for (const id of ["retro-agent", "reviewed"])
    await expect(
      f.write(second, { action: "inventory", sessions: [session(id)] }),
    ).rejects.toMatchObject({ status: 400 });
  const g = await fixture();
  await g.configure();
  const baseline = await g.create();
  await g.write(baseline, { action: "publish", report: report("from-now") });
  await g.write(baseline, { action: "finish", operatorInstruction: "Start now" });
  const later = await g.create("later-retro");
  await g.write(later, {
    action: "publish",
    report: {
      ...report("none"),
      agent: { sourceId: "local", runtime: "codex", sessionId: "later-agent" },
    },
  });
  await expect(
    g.write(later, { action: "inventory", sessions: [{ ...session("unknown"), startedAt: null }] }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    g.write(later, { action: "inventory", sessions: [session("old-resumed")] }),
  ).rejects.toMatchObject({ status: 400 });
});

test("decisions do no file work, preserve exact edits, require honest outcomes and cannot transfer acceptance to changed proposals", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  const finding = {
    id: "fix-checks",
    category: "workflow" as const,
    title: "Run focused tests",
    text: "Use the established command",
    evidence: ["Synthetic missing check"],
    sessions: [],
    proposal: { destination, kind: "correction" as const, text: "Run focused checks" },
  };
  await f.write(owner, { action: "publish", report: { ...report(), findings: [finding] } });
  await f.write(owner, {
    action: "decide",
    findingId: finding.id,
    decision: "edit",
    text: "Run vp run ready",
    destination,
  });
  expect((await f.read()).decisions).toMatchObject([{ text: "Run vp run ready", destination }]);
  await expect(
    f.write(owner, {
      action: "publish",
      report: {
        ...report(),
        findings: [
          { ...finding, proposal: { ...finding.proposal, text: "Run unrelated changes" } },
        ],
      },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409 });
  await f.write(owner, {
    action: "request",
    findingId: finding.id,
    text: "Confirm the check command",
  });
  const request = (await f.read()).requests[0];
  await f.write(owner, {
    action: "outcomes",
    outcomes: [
      {
        findingId: finding.id,
        status: "declined",
        evidence: "Operator declined final edit; no files were changed.",
      },
    ],
  });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409 });
  await f.write(owner, {
    action: "resolve-request",
    id: request.id,
    status: "answered",
    response: "Checked the existing development guide.",
  });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish" });
  expect((await f.read()).outcomes[0].status).toBe("declined");
});

test("Memory Off and unverified destination capabilities reject proposals and edited destinations", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  const finding = {
    id: "memory",
    category: "recurring" as const,
    title: "Preference",
    text: "Shorter explanations",
    evidence: [],
    sessions: [],
    proposal: { destination, kind: "memory" as const, text: "Use concise language" },
  };
  await expect(
    f.write(owner, { action: "publish", report: { ...report(), findings: [finding] } }),
  ).rejects.toMatchObject({ status: 400 });
  await f.write(owner, {
    action: "publish",
    report: {
      ...report(),
      findings: [{ ...finding, proposal: { ...finding.proposal, kind: "correction" } }],
    },
  });
  await expect(
    f.write(owner, {
      action: "decide",
      findingId: "memory",
      decision: "edit",
      text: "Edit",
      destination: { ...destination, path: "/other" },
    }),
  ).rejects.toMatchObject({ status: 400 });
  const settings = await f.client.retro({ action: "settings" });
  if (settings.type !== "configuration") throw new Error("Expected config");
  await f.configure({
    ...settings.configuration,
    memory: { enabled: true, destinations: [destination] },
  });
  await f.write(owner, { action: "publish", report: { ...report(), findings: [finding] } });
  const enabled = await f.client.retro({ action: "settings" });
  if (enabled.type !== "configuration") throw new Error("Expected config");
  await f.configure({
    ...enabled.configuration,
    memory: { ...enabled.configuration.memory, enabled: false },
  });
  expect((await f.read()).report.findings[0].proposal).toBeUndefined();
  await expect(
    f.write(owner, { action: "decide", findingId: "memory", decision: "accept", text: "Accepted" }),
  ).rejects.toMatchObject({ status: 400 });
});

test("authored state survives HTML replacement and restart, uses independent versions and freezes with finish", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  const patch: RetroCommand = {
    action: "state-patch",
    name: owner.name,
    tabId: owner.tabId,
    requestId: randomUUID(),
    expectedVersion: 0,
    value: { filters: { category: "speed" } },
  };
  const saved = await f.client.retro(patch);
  expect(await f.client.retro(patch)).toEqual(saved);
  await expect(f.client.retro({ ...patch, requestId: randomUUID() })).rejects.toMatchObject({
    status: 409,
  });
  await f.client.publish(
    owner.artifact.id,
    { ...metadata(owner.artifact), expectedRevision: owner.artifact.revision },
    Buffer.from("<h1>Replacement</h1>"),
  );
  await f.restart();
  expect((await f.read()).appState).toEqual({
    version: 1,
    value: { filters: { category: "speed" } },
  });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish" });
  await expect(f.write(owner, { action: "state-patch", value: { x: 1 } })).rejects.toMatchObject({
    status: 409,
  });
});

test("bounded inventory pages stay consistent and partially delivered pages cannot finish", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report("all", 201) });
  await f.write(owner, {
    action: "inventory",
    sessions: Array.from({ length: 200 }, (_, i) => session(`id-${String(i).padStart(3, "0")}`)),
  });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish incomplete" }),
  ).rejects.toMatchObject({ status: 409 });
  await f.write(owner, { action: "inventory", sessions: [session("id-200")] });
  const first = await f.read();
  expect(first.sessions).toHaveLength(200);
  expect(first.next).toBeTruthy();
  const second = await f.client.retro({
    action: "read",
    name: owner.name,
    after: first.next!,
    version: first.version,
  });
  expect(second).toMatchObject({ snapshot: { sessions: [{ sessionId: "id-200" }], next: null } });
  await f.write(owner, { action: "comment", findingId: null, text: "Next version" });
  await expect(
    f.client.retro({
      action: "read",
      name: owner.name,
      after: first.next!,
      version: first.version,
    }),
  ).rejects.toMatchObject({ status: 409 });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish complete" });
  const tracking = await f.client.retro({
    action: "tracking",
    sourceId: "local",
    runtime: "codex",
  });
  expect(tracking.type).toBe("tracking");
  if (tracking.type !== "tracking") return;
  expect(tracking.audited).toHaveLength(200);
  expect(tracking.next).toBeTruthy();
});

test("direct and forwarded API reject malformed config, publication after finish and concurrent late publication", async () => {
  const f = await fixture();
  const hub = await startHub({ endpoint: f.server.url, token, port: 0 });
  cleanup.push(hub.close);
  const remote = new ScopeClient(hub.url, token);
  for (const endpoint of [f.server.url, hub.url]) {
    const bad = await fetch(`${endpoint}/v1/retros`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "configure",
        requestId: randomUUID(),
        expectedVersion: 0,
        configuration: { ...configuration(), sshSecret: "must reject" },
      }),
    });
    expect(bad.status).toBe(400);
  }
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  const current = await f.read();
  const operations = await Promise.allSettled([
    remote.retro({
      action: "finish",
      name: owner.name,
      tabId: owner.tabId,
      requestId: randomUUID(),
      expectedVersion: current.version,
      operatorInstruction: "Finish now",
    }),
    remote.publish(
      owner.artifact.id,
      { ...metadata(owner.artifact), expectedRevision: owner.artifact.revision },
      Buffer.from("<h1>Concurrent publication</h1>"),
    ),
  ]);
  expect(operations[0].status).toBe("fulfilled");
  const final = await f.client.get(owner.artifact.id);
  const bytes = await f.client.content(final.id, final.revision);
  await expect(
    remote.publish(
      final.id,
      { ...metadata(final), expectedRevision: final.revision },
      Buffer.from("Late edit"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.client.content(final.id, final.revision)).toEqual(bytes);
});

test("built CLI publishes retro HTML and reads settings, commands and history", async () => {
  const f = await fixture();
  await f.configure();
  const html = join(f.directory, "report.html");
  await writeFile(html, "<h1>CLI report</h1>");
  const added = JSON.parse(
    (await f.cli("add", html, "--retro", "--name", "cli-retro")).stdout,
  ) as Artifact;
  expect(added.kind).toBe("retro");
  expect(JSON.parse((await f.cli("retro", "guide")).stdout).schema).toBeTruthy();
  expect(JSON.parse((await f.cli("retro", "settings")).stdout).configuration.memory.enabled).toBe(
    false,
  );
  const owner = await f.read("cli-retro");
  const file = join(f.directory, "command.json");
  await writeFile(
    file,
    JSON.stringify({
      action: "publish",
      name: "cli-retro",
      tabId: owner.tabId,
      expectedVersion: owner.version,
      requestId: randomUUID(),
      report: report(),
    }),
  );
  expect(JSON.parse((await f.cli("retro", "apply", file)).stdout).type).toBe("receipt");
  expect(
    JSON.parse((await f.cli("retro", "read", "cli-retro")).stdout).snapshot.report.summary,
  ).toBe("Reviewed synthetic sessions");
  await f.write(
    { name: "cli-retro", tabId: owner.tabId },
    { action: "finish", operatorInstruction: "Finish CLI report" },
  );
  expect(JSON.parse((await f.cli("retro", "history")).stdout).entries[0].artifact.id).toBe(
    added.id,
  );
});

test("version 10 migration preserves existing artifacts and adds durable retrospective records", async () => {
  const f = await fixture();
  const old = await f.client.publish(
    "old-file",
    {
      title: "Old",
      kind: "text",
      mediaType: "text/plain",
      fileName: "old.txt",
      expectedRevision: 0,
    },
    Buffer.from("Existing bytes"),
  );
  await f.server.close();
  const db = new DatabaseSync(join(f.directory, "scope.db"));
  for (const table of [
    "retro_reports",
    "retro_sessions",
    "retro_receipts",
    "retro_audits",
    "retro_initialization",
  ])
    db.exec(`DROP TABLE ${table}`);
  db.exec("PRAGMA user_version = 10");
  db.close();
  await f.restart();
  expect(Buffer.from(await f.client.content(old.id, old.revision))).toEqual(
    Buffer.from("Existing bytes"),
  );
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish migrated profile" });
  await f.restart();
  expect((await f.read()).status).toBe("finished");
});

test("repository origins unify GitHub SSH/HTTPS and retain fork, non-GitHub case and port distinctions", () => {
  expect(canonicalRetroRepository("git@github.com:Operator/Project.git")).toBe(repository);
  expect(canonicalRetroRepository("ssh://git@github.com:22/Operator/Project.git")).toBe(repository);
  expect(canonicalRetroRepository("https://github.com:443/Operator/Project.git")).toBe(repository);
  expect(canonicalRetroRepository("https://github.com:22/Operator/Project.git")).toBe(
    "github.com:22/Operator/Project",
  );
  expect(canonicalRetroRepository("ssh://git@github.com:443/Operator/Project.git")).toBe(
    "github.com:443/Operator/Project",
  );
  expect(canonicalRetroRepository("https://github.com/OPERATOR/PROJECT")).toBe(repository);
  expect(canonicalRetroRepository("https://github.com/fork/project")).not.toBe(repository);
  expect(canonicalRetroRepository("ssh://git@Git.Example:2222/Team/Project.git")).toBe(
    "git.example:2222/Team/Project",
  );
  expect(canonicalRetroRepository("https://Git.Example:443/Team/Project.git")).toBe(
    "git.example:443/Team/Project",
  );
  expect(canonicalRetroRepository("ssh://git@github.com:2222/Team/Project.git")).toBe(
    "github.com:2222/Team/Project",
  );
  expect(canonicalRetroRepository("/local/project")).toBeNull();
  expect(canonicalRetroRepository("https://git.example/Team/../Project")).toBeNull();
});

test("cumulative notes remain readable when the next write exceeds the document quota", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  const findings = Array.from({ length: 105 }, (_, i) => ({
    id: `finding-${i}`,
    category: "efficiency" as const,
    title: "Synthetic finding",
    text: "x".repeat(16384),
    evidence: [],
    sessions: [],
  }));
  await f.write(owner, { action: "publish", report: { ...report(), findings } });
  let version = 1;
  let accepted = 0;
  let rejected = false;
  for (let i = 0; i < 40; i++) {
    try {
      const result = await f.client.retro({
        action: "comment",
        name: owner.name,
        tabId: owner.tabId,
        expectedVersion: version,
        requestId: randomUUID(),
        findingId: null,
        text: "☃".repeat(16384),
      });
      if (result.type !== "receipt") throw new Error("Expected receipt");
      version = result.version;
      accepted++;
    } catch (error) {
      expect(error).toMatchObject({ status: 413 });
      rejected = true;
      break;
    }
  }
  expect(rejected).toBe(true);
  const current = await f.read();
  expect(current.comments).toHaveLength(accepted);
  expect(current.version).toBe(version);
  await f.restart();
  expect((await f.read()).comments).toHaveLength(accepted);
});

test("built watch delivers durable requests and stops after conversational finish", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  const child = spawn(
    process.execPath,
    [resolve("packages/cli/dist/main.mjs"), "retro", "watch", owner.name],
    {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: f.server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const stopped = new Promise<number | null>((resolve) => child.once("close", resolve));
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await stopped;
  });
  await expect
    .poll(() => diagnostics, { timeout: 10000 })
    .toContain(`Listening for retrospective decisions on ${owner.name}`);
  await f.write(owner, {
    action: "request",
    findingId: null,
    text: "Verify the synthetic coverage",
  });
  await expect.poll(() => output, { timeout: 10000 }).toContain("Verify the synthetic coverage");
  const notices = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(notices[0].name).toBe(owner.name);
  expect(notices[0].text).toContain("Do not finish until the operator explicitly asks");
  const request = (await f.read()).requests[0];
  await f.write(owner, {
    action: "resolve-request",
    id: request.id,
    status: "answered",
    response: "Verified synthetic coverage.",
  });
  await f.write(owner, { action: "finish", operatorInstruction: "Please finish" });
  expect(await stopped).toBe(0);
});

test("paired hub forwards retrospective commands live, then rejects edits to completed HTML", async () => {
  const f = await fixture();
  const state = await HubState.open(join(f.directory, "hub"));
  cleanup.push(async () => state.close());
  const connectionFile = join(f.directory, "hub-connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const connection = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const remote = new ScopeClient(hub.url, connection.token);
  const remotes = new Remotes(f.desktop, { url: f.server.url, token }, () => {});
  cleanup.push(async () => remotes.close());
  await remotes.start();
  await remotes.pair(state.pairUrl());
  await expect.poll(() => remotes.snapshot()[0]?.connection).toBe("connected");
  expect(await remote.retro({ action: "settings" })).toMatchObject({
    configuration: { version: 0 },
  });
  const configured = await remote.retro({
    action: "configure",
    requestId: randomUUID(),
    expectedVersion: 0,
    configuration: configuration(),
  });
  expect(configured).toMatchObject({ configuration: { version: 1 } });
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  const snapshot = await f.read();
  await remote.retro({
    action: "finish",
    name: owner.name,
    tabId: owner.tabId,
    requestId: randomUUID(),
    expectedVersion: snapshot.version,
    operatorInstruction: "Finish from paired source",
  });
  expect(await remote.retro({ action: "history" })).toMatchObject({
    entries: [{ artifact: { id: owner.artifact.id } }],
  });
  await expect(
    remote.publish(
      owner.artifact.id,
      { ...metadata(owner.artifact), expectedRevision: owner.artifact.revision },
      Buffer.from("Late publication"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const malformed = await fetch(`${hub.url}/v1/retros`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "settings", execute: "must reject" }),
  });
  expect(malformed.status).toBe(400);
});

test("general code corrections use verified report destinations without enabling memory", async () => {
  const f = await fixture();
  await f.configure({ ...configuration(), memory: { enabled: false, destinations: [] } });
  const owner = await f.create();
  const file: RetroDestination = {
    ...destination,
    id: "test-command",
    type: "file",
    path: "/synthetic/tools/test.ts",
  };
  const finding = {
    id: "fix-runner",
    category: "correctness" as const,
    title: "Correct runner",
    text: "Use the correct executable",
    evidence: ["Synthetic failing check"],
    sessions: [],
    proposal: { destination: file, kind: "correction" as const, text: "Use vp exec" },
  };
  await f.write(owner, {
    action: "publish",
    report: { ...report(), destinations: [file], findings: [finding] },
  });
  expect((await f.read()).permittedDestinations).toEqual([file]);
  await f.write(owner, {
    action: "decide",
    findingId: finding.id,
    decision: "accept",
    text: "ignored client text",
  });
  expect((await f.read()).decisions[0]).toMatchObject({ text: "Use vp exec", destination: file });
  await expect(
    f.write(owner, {
      action: "decide",
      findingId: finding.id,
      decision: "edit",
      text: "Other",
      destination: { ...file, type: "claude-memory" },
    }),
  ).rejects.toMatchObject({ status: 400 });
});

test("finish flushes authored edits before its transaction and requires re-read after a version change", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  let flushed = false;
  f.server.store.retros.setBeforeFinish(async () => {
    if (flushed) return;
    flushed = true;
    await f.client.retro({
      action: "state-patch",
      name: owner.name,
      tabId: owner.tabId,
      requestId: randomUUID(),
      expectedVersion: 0,
      value: { draft: "Unsubmitted operator comment" },
    });
  });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.read()).status).toBe("active");
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: false, audited: [] });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish after saved drafts" });
  expect((await f.read()).appState.value).toEqual({ draft: "Unsubmitted operator comment" });
});

test("failed authored flush leaves the report active and all initialization untouched", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  await f.write(owner, { action: "publish", report: report() });
  f.server.store.retros.setBeforeFinish(async () => {
    throw new Error("Synthetic unsaved edit failure");
  });
  await expect(
    f.write(owner, { action: "finish", operatorInstruction: "Finish" }),
  ).rejects.toMatchObject({ status: 409, message: "Synthetic unsaved edit failure" });
  expect((await f.read()).status).toBe("active");
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: false, audited: [] });
  f.server.store.retros.setBeforeFinish(undefined);
  await f.write(owner, { action: "finish", operatorInstruction: "Finish after resolving drafts" });
});

test("native activity later than discovery is excluded at fractional second precision", async () => {
  const f = await fixture();
  await f.configure();
  const owner = await f.create();
  const discoveredAt = "2026-10-04T08:00:00.123000Z";
  await f.write(owner, {
    action: "publish",
    report: {
      ...report("all", 1),
      sources: report().sources.map((s) => ({ ...s, discoveredAt, sessionCount: 1 })),
    },
  });
  await expect(
    f.write(owner, {
      action: "inventory",
      sessions: [{ ...session("late"), lastActivityAt: "2026-10-04T08:00:00.123001Z" }],
    }),
  ).rejects.toMatchObject({ status: 400 });
  await f.write(owner, {
    action: "inventory",
    sessions: [{ ...session("eligible"), lastActivityAt: "2026-10-04T08:00:00.123Z" }],
  });
  await f.write(owner, { action: "finish", operatorInstruction: "Finish saved discovery" });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ audited: ["eligible"] });
});

test("concurrent initialization rejects a pending retro without auditing its old selection", async () => {
  const f = await fixture();
  await f.configure();
  const pending = await f.create("pending-all");
  await f.write(pending, { action: "publish", report: report("all", 1) });
  await f.write(pending, { action: "inventory", sessions: [session("old")] });
  const newer = await f.create("new-start");
  await f.write(newer, { action: "publish", report: report("from-now") });
  await f.write(newer, { action: "finish", operatorInstruction: "Finish from now." });
  await expect(
    f.write(pending, { action: "finish", operatorInstruction: "Finish All." }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.read(pending.name)).status).toBe("active");
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ initialized: true, mode: "from-now", cutoff, audited: [] });
  const revised = report("none", 1);
  await f.write(pending, { action: "publish", report: revised });
  await f.write(pending, { action: "inventory", sessions: [session("old", "ignored")] });
  await f.write(pending, { action: "finish", operatorInstruction: "Finish revised selection." });
  expect(
    await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
  ).toMatchObject({ mode: "from-now", audited: [] });
});

test.each(["reviewed", "agent", "repository"])(
  "finish rechecks %s exclusions changed after inventory",
  async (changed) => {
    const f = await fixture();
    await f.configure();
    const initial = await f.create("initial");
    await f.write(initial, { action: "publish", report: report() });
    await f.write(initial, { action: "finish", operatorInstruction: "Initialize." });
    const pending = await f.create("pending");
    await f.write(pending, { action: "publish", report: report("none", 1) });
    await f.write(pending, { action: "inventory", sessions: [session("historical")] });
    if (changed === "repository") {
      const settings = await f.client.retro({ action: "settings" });
      if (settings.type !== "configuration") throw new Error("Expected configuration");
      await f.configure({
        ...settings.configuration,
        repositories: [{ repository, included: false }],
      });
    } else {
      const other = await f.create("other");
      const value: RetroReport = {
        ...report("none", changed === "reviewed" ? 1 : 0),
        ...(changed === "agent"
          ? { agent: { sourceId: "local", runtime: "codex", sessionId: "historical" } as const }
          : {}),
      };
      await f.write(other, { action: "publish", report: value });
      if (changed === "reviewed") {
        await f.write(other, { action: "inventory", sessions: [session("historical")] });
        await f.write(other, { action: "finish", operatorInstruction: "Finish other." });
      }
    }
    await expect(
      f.write(pending, { action: "finish", operatorInstruction: "Finish pending." }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.read(pending.name)).status).toBe("active");
    expect(
      await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
    ).toMatchObject({ mode: "all", audited: changed === "reviewed" ? ["historical"] : [] });
  },
);

test.each(["excluded", "removed", "runtime"])(
  "finish does not initialize or audit a source whose %s configuration changed",
  async (changed) => {
    const f = await fixture();
    await f.configure(configuration(["codex", "claude"]));
    const owner = await f.create();
    const original = report("all", 1);
    const coverage: RetroReport = {
      ...original,
      sources: [
        ...original.sources,
        { ...original.sources[0], runtime: "claude", sessionCount: 0 },
      ],
    };
    await f.write(owner, { action: "publish", report: coverage });
    await f.write(owner, { action: "inventory", sessions: [session("historical")] });
    const settings = await f.client.retro({ action: "settings" });
    if (settings.type !== "configuration") throw new Error("Expected configuration");
    const value = settings.configuration;
    await f.configure({
      ...value,
      sources:
        changed === "removed"
          ? []
          : value.sources.map((source) => ({
              ...source,
              included: changed !== "excluded",
              runtimes: changed === "runtime" ? ["claude"] : source.runtimes,
            })),
      memory: changed === "removed" ? { enabled: false, destinations: [] } : value.memory,
    });
    await expect(
      f.write(owner, { action: "finish", operatorInstruction: "Finish." }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.read(owner.name)).status).toBe("active");
    expect(
      await f.client.retro({ action: "tracking", sourceId: "local", runtime: "codex" }),
    ).toMatchObject({ initialized: false, audited: [] });
  },
);
