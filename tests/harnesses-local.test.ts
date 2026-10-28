import { expect, test } from "vite-plus/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import {
  HarnessesGuide,
  type HarnessReport,
  type HarnessesReply,
} from "@irudd-scope/protocol/harnesses";
import { desktopFixture } from "./desktop-fixture.ts";
import {
  folderSize,
  harness,
  harnessHome,
  instruction,
  instructions,
  notFound,
  snapshot,
  withoutSize,
} from "./harnesses-fixture.ts";

const codex = (linkedOverride = false): Omit<HarnessReport, "size"> => ({
  id: "codex",
  name: "Codex",
  found: true,
  home: "~/.codex",
  version: "0.200.0",
  signIn: { state: "signed-in", method: "chatgpt" },
  skills: [
    { name: "review", location: "own", linked: false },
    { name: "imagegen", location: "bundled", linked: false },
  ],
  agents: [{ name: "helper", location: "own", linked: false, kind: "agent" }],
  mcpServers: [
    { name: "docs", transport: "stdio", location: "own" },
    { name: "remote", transport: "http", location: "own" },
  ],
  instructions: [
    instruction("~/.codex/AGENTS.md", instructions.codex),
    ...(linkedOverride ? [linkedInstruction("~/.codex/AGENTS.override.md")] : []),
  ],
  unreadable: [],
  truncated: false,
});
const claude = (version: string | null, broken = false): Omit<HarnessReport, "size"> => ({
  id: "claude-code",
  name: "Claude Code",
  found: true,
  home: "~/.claude",
  version,
  signIn: broken ? { state: "unknown", method: null } : { state: "signed-in", method: "oauth" },
  skills: [
    { name: "notes", location: "own", linked: false },
    { name: "outside", location: "own", linked: true },
  ],
  agents: [{ name: "reviewer", location: "own", linked: false, kind: "agent" }],
  mcpServers: broken
    ? []
    : [
        { name: "github", transport: "http", location: "own" },
        { name: "local", transport: "stdio", location: "own" },
      ],
  instructions: [instruction("~/.claude/CLAUDE.md", instructions.claude)],
  unreadable: broken ? ["~/.claude.json"] : [],
  truncated: false,
});
/** With a linked ~/.grok/bundled, nothing bundled is listed. */
const grok = (version: string, linkedBundled = false): Omit<HarnessReport, "size"> => ({
  id: "grok",
  name: "Grok Build",
  found: true,
  home: "~/.grok",
  version,
  signIn: { state: "signed-in", method: null },
  skills: [
    { name: "own-skill", location: "own", linked: false },
    ...(linkedBundled
      ? []
      : [{ name: "code-review", location: "bundled", linked: false } as const]),
  ],
  agents: [
    { name: "scout", location: "own", linked: false, kind: "agent" },
    ...(linkedBundled
      ? []
      : ([
          { name: "explore", location: "bundled", linked: false, kind: "agent" },
          { name: "reviewer", location: "bundled", linked: false, kind: "persona" },
          { name: "plan", location: "bundled", linked: false, kind: "role" },
        ] as const)),
  ],
  mcpServers: [
    { name: "events", transport: "sse", location: "own" },
    { name: "search", transport: "http", location: "own" },
  ],
  instructions: [instruction("~/.grok/AGENTS.md", instructions.grok)],
  unreadable: [],
  truncated: false,
});
const cursor = (): Omit<HarnessReport, "size"> => ({
  id: "cursor",
  name: "Cursor",
  found: true,
  home: "~/.cursor",
  version: "2026.11.02-abc1234",
  signIn: { state: "signed-in", method: null },
  skills: [
    { name: "own-cursor", location: "own", linked: false },
    { name: "canvas", location: "bundled", linked: false },
  ],
  agents: [],
  mcpServers: [
    { name: "plan", transport: "http", location: "own" },
    { name: "tool", transport: "stdio", location: "own" },
  ],
  instructions: [],
  unreadable: [],
  truncated: false,
});
/** A linked ~/.agents/skills is reported as linked with nothing listed inside it. */
const sharedSkills = (linked = false) => ({
  found: true,
  linked,
  home: "~/.agents/skills",
  skills: linked
    ? []
    : [
        { name: "linked-shared", linked: true },
        { name: "shared-one", linked: false },
      ],
  truncated: false,
});
const linkedInstruction = (path: string) => ({
  path,
  linked: true,
  bytes: null,
  lines: null,
  sha256: null,
});

/** Reads until every found harness has its final size; the test timeout bounds the wait. */
async function readUntilSized(cli: (...args: string[]) => Promise<{ stdout: string }>) {
  for (;;) {
    const reply = JSON.parse(
      (await cli("harnesses", "read", "--machine", "local")).stdout,
    ) as HarnessesReply;
    const sizes = reply.machines[0]!.harnesses.filter((report) => report.found);
    if (sizes.every((report) => report.size?.state === "done")) return reply;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function expectReport(
  reply: HarnessesReply,
  home: string,
  expected: Array<Omit<HarnessReport, "size">>,
  missing: HarnessReport[],
  linkedShared = false,
) {
  const machine = reply.machines[0]!;
  expect(reply.machines).toHaveLength(1);
  expect(machine.machine).toBe("local");
  expect(Date.parse(machine.scannedAt)).not.toBeNaN();
  expect(machine.sharedSkills).toEqual(sharedSkills(linkedShared));
  expect(machine.harnesses.map((report) => report.id).sort()).toEqual(
    ["claude-code", "codex", "cursor", "grok"].sort(),
  );
  for (const report of expected)
    expect(harness(reply, report.id)).toEqual({
      ...report,
      size: await folderSize(join(home, report.home.slice(2))),
    });
  for (const report of missing) expect(harness(reply, report.id)).toEqual(report);
}

test(
  "harnesses read reports each harness on this computer from its own folders",
  { tags: ["harnesses-look-dont-touch"], timeout: 120_000 },
  async () => {
    const fixture = await harnessHome({ cursor: false, brokenClaudeJson: true });
    const { launch, cli, stderr } = await desktopFixture({
      hideInitialPrompts: true,
      env: fixture.env,
    });
    const application = await launch();
    const seen: string[] = [];
    try {
      const guide = JSON.parse((await cli("harnesses", "guide")).stdout) as typeof HarnessesGuide;
      expect(Object.keys(guide.commands).sort()).toEqual(["guide", "read", "scan"]);
      expect(Object.keys(guide.fields)).toEqual(
        expect.arrayContaining([
          "found",
          "version",
          "signIn",
          "size",
          "skills",
          "agents",
          "mcpServers",
          "instructions",
          "sharedSkills",
        ]),
      );
      expect(guide.fields.version).toContain("last resort");
      expect(guide.folders.shared).toContain("~/.agents/skills");
      expect(guide.rules.join(" ")).toContain("makes no claim");

      const output = (await cli("harnesses", "scan")).stdout;
      seen.push(output);
      const scanned = JSON.parse(output) as HarnessesReply;
      expect(withoutSize(harness(scanned, "codex"))).toEqual({ ...codex(), size: undefined });
      const reply = await readUntilSized(cli);
      seen.push(JSON.stringify(reply));
      // An invalid ~/.claude.json is reported as unreadable and its sign-in as unknown.
      await expectReport(
        reply,
        fixture.home,
        [codex(), claude(null, true), grok("1.2.3")],
        [notFound("cursor", "Cursor", "~/.cursor")],
      );

      await expect(cli("harnesses", "read", "--machine", "all")).rejects.toMatchObject({
        stderr: expect.stringContaining("Unknown machine all. Use --machine local."),
      });
    } finally {
      await application.close();
    }
    try {
      const searched = [...seen, stderr()].join("\n");
      for (const marker of fixture.markers) expect(searched).not.toContain(marker);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "harness scans change no file and reveal no secret in output, HTTP, storage or logs",
  {
    tags: ["harnesses-look-dont-touch", "secrets-stay-secret", "survives-restart"],
    timeout: 180_000,
  },
  async () => {
    const fixture = await harnessHome({ cursor: true, grokStub: true, linkedFolders: true });
    const { launch, cli, connectionFile, settingsDirectory, stderr } = await desktopFixture({
      hideInitialPrompts: true,
      env: fixture.env,
    });
    const before = await snapshot(fixture.home);
    const outside = await snapshot(fixture.root, ["outside"]);
    const seen: string[] = [];
    let application = await launch();
    try {
      seen.push((await cli("harnesses", "scan", "--machine", "local")).stdout);
      const reply = await readUntilSized(cli);
      seen.push(JSON.stringify(reply));
      await expectReport(
        reply,
        fixture.home,
        [codex(true), claude("2.2.0"), grok("1.3.0", true), cursor()],
        [],
        true,
      );
      // The linked skill's folder outside home holds a 777 KB file that no total includes.
      expect(harness(reply, "claude-code").size).toEqual(
        await folderSize(join(fixture.home, ".claude")),
      );

      const { endpoint, token } = decodeLocalConnection(
        JSON.parse(await readFile(connectionFile, "utf8")),
      );
      const headers = { Authorization: `Bearer ${token}` };
      for (const response of [
        await fetch(`${endpoint}/v1/harnesses?machine=local`, { headers }),
        await fetch(`${endpoint}/v1/harnesses/scan`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ machine: "local" }),
        }),
      ]) {
        expect(response.status).toBe(200);
        seen.push(await response.text());
      }
      await readUntilSized(cli);
      await application.close();

      // The saved scan answers after a restart, before or while the new scan runs.
      application = await launch();
      const saved = JSON.parse(
        (await cli("harnesses", "read", "--machine", "local")).stdout,
      ) as HarnessesReply;
      seen.push(JSON.stringify(saved));
      expect(withoutSize(harness(saved, "cursor"))).toEqual({ ...cursor(), size: undefined });
      await readUntilSized(cli);
    } finally {
      await application.close();
    }
    try {
      const database = join(settingsDirectory, "desktop.db");
      const stored = [
        await readFile(database, "latin1"),
        await readFile(`${database}-wal`, "latin1").catch(() => ""),
      ];
      expect(stored[0]).toContain("harness_scans");
      const output = [...seen, ...stored, stderr()].join("\n");
      for (const marker of fixture.markers) expect(output).not.toContain(marker);
      expect(await snapshot(fixture.home)).toEqual(before);
      expect(await snapshot(fixture.root, ["outside"])).toEqual(outside);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test(
  "a harness scan answers before a big folder finishes counting",
  { tags: ["harnesses-look-dont-touch"], timeout: 240_000 },
  async () => {
    const fixture = await harnessHome({ cursor: false });
    const sessions = join(fixture.home, ".codex", "sessions", "bulk");
    for (let folder = 0; folder < 50; folder += 1) {
      const path = join(sessions, String(folder));
      await mkdir(path, { recursive: true });
      await Promise.all(
        Array.from({ length: 1000 }, (_, index) =>
          writeFile(join(path, `${index}.jsonl`), "x".repeat(1 + (index % 3))),
        ),
      );
    }
    const expected = await folderSize(join(fixture.home, ".codex"));
    expect(expected.files).toBeGreaterThan(50_000);
    const { launch, cli } = await desktopFixture({ hideInitialPrompts: true, env: fixture.env });
    const application = await launch();
    try {
      const scanned = JSON.parse((await cli("harnesses", "scan")).stdout) as HarnessesReply;
      const first = JSON.parse(
        (await cli("harnesses", "read", "--machine", "local")).stdout,
      ) as HarnessesReply;
      // A scan answers before counting; the first read may already have the final size.
      expect(harness(scanned, "codex").size).toEqual({ state: "pending" });
      for (const reply of [scanned, first])
        expect(withoutSize(harness(reply, "codex"))).toEqual({ ...codex(), size: undefined });
      expect([{ state: "pending" }, expected]).toContainEqual(harness(first, "codex").size);
      expect(harness(await readUntilSized(cli), "codex").size).toEqual(expected);
    } finally {
      await application.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);
