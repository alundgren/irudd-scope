import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { HarnessReport, HarnessesReply } from "@irudd-scope/protocol/harnesses";

type Writer = {
  home: string;
  /** Returns a unique value that must never appear in any output, log or saved scan. */
  secret: (label: string) => string;
  file: (path: string, content: string, mode?: number) => Promise<void>;
  link: (path: string, target: string) => Promise<void>;
};

/** Synthetic harness folders under a temporary home, with secrets that must never leak. */
export async function harnessHome(options: { cursor: boolean; grokStub?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "scope-harnesses-"));
  const home = join(root, "home");
  const outside = join(root, "outside");
  const markers: string[] = [];
  const w: Writer = {
    home,
    secret: (label) => {
      const value = `${label}-${randomUUID()}`;
      markers.push(value);
      return value;
    },
    file: async (path, content, mode) => {
      await mkdir(dirname(join(home, path)), { recursive: true });
      await writeFile(join(home, path), content);
      if (mode) await chmod(join(home, path), mode);
    },
    link: async (path, target) => {
      await mkdir(dirname(join(home, path)), { recursive: true });
      await symlink(target, join(home, path));
    },
  };
  // A skill link that leaves home; its folder's bytes and marker must never be read or counted.
  await mkdir(join(outside, "linked-skill"), { recursive: true });
  await writeFile(
    join(outside, "linked-skill", "SKILL.md"),
    `${w.secret("outside-file")}\n${"x".repeat(777_777)}`,
  );
  await writeCodex(w);
  await writeClaude(w, outside);
  await writeGrok(w, options.grokStub ?? false);
  if (options.cursor) await writeCursor(w);
  else await w.file(".local/bin/claude", stub("exit 3"), 0o755);
  await w.file(".agents/skills/shared-one/SKILL.md", "# Shared\n");
  await w.link(".agents/skills/linked-shared", "../../.claude/skills/notes");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    // The fixture's binaries come first and the real account's per-user tools are removed.
    PATH: [
      join(home, ".local", "bin"),
      dirname(process.execPath),
      ...(process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.includes(".local")),
    ].join(delimiter),
  };
  return { root, home, outside, markers, env };
}

async function writeCodex(w: Writer) {
  await w.file(
    ".codex/auth.json",
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: w.secret("codex-api-key"),
      tokens: { access_token: w.secret("codex-access"), refresh_token: w.secret("codex-refresh") },
    }),
  );
  await w.file(
    ".codex/config.toml",
    [
      'model = "synthetic"',
      "[mcp_servers.docs]",
      'command = "docs-server"',
      `args = ["--key", "${w.secret("codex-arg")}"]`,
      `env = { DOCS_TOKEN = "${w.secret("codex-env")}" }`,
      "[mcp_servers.remote]",
      `url = "https://${w.secret("codex-url")}.example.test/mcp"`,
      `http_headers = { Authorization = "Bearer ${w.secret("codex-header")}" }`,
      "",
    ].join("\n"),
  );
  await w.file(".codex/AGENTS.md", instructions.codex);
  await w.file(".codex/skills/review/SKILL.md", "# Review\n");
  await w.file(".codex/skills/.system/imagegen/SKILL.md", "# Image generation\n");
  await w.file(".codex/agents/helper.toml", 'name = "helper"\n');
  await w.file(".codex/sessions/2026/10/rollout.jsonl", `${w.secret("codex-session")}\n`);
  const release = ".codex/packages/standalone/releases/0.200.0-x86_64-unknown-linux-musl";
  await w.file(`${release}/codex`, "binary");
  await w.link(".codex/packages/standalone/current", join(w.home, release));
}

async function writeClaude(w: Writer, outside: string) {
  await w.file(
    ".claude.json",
    JSON.stringify({
      numStartups: 3,
      oauthAccount: {
        emailAddress: `${w.secret("claude-email")}@example.test`,
        displayName: w.secret("claude-display"),
        fullName: w.secret("claude-full"),
        organizationName: w.secret("claude-org"),
      },
      mcpServers: {
        github: {
          type: "http",
          url: `https://${w.secret("claude-url")}.example.test/mcp`,
          headers: { Authorization: `Bearer ${w.secret("claude-header")}` },
        },
        local: { command: "local-server", env: { LOCAL_KEY: w.secret("claude-env") } },
      },
      projects: { "/work": { history: [w.secret("claude-history")] } },
    }),
  );
  await w.file(".claude/CLAUDE.md", instructions.claude);
  await w.file(".claude/skills/notes/SKILL.md", "# Notes\n");
  await w.link(".claude/skills/outside", join(outside, "linked-skill"));
  await w.file(".claude/agents/reviewer.md", "# Reviewer\n");
  await w.file(".claude/projects/work/session.jsonl", `${w.secret("claude-session")}\n`);
  await w.file(
    ".claude/.credentials.json",
    JSON.stringify({ token: w.secret("claude-credentials") }),
  );
}

/** Grok's version comes from its binary link, or from a `--version` stub when there is none. */
async function writeGrok(w: Writer, grokStub: boolean) {
  await w.file(
    ".grok/auth.json",
    JSON.stringify({ "https://auth.example.test": w.secret("grok-token") }),
  );
  await w.file(
    ".grok/config.toml",
    [
      "[mcp_servers.search]",
      `url = "https://${w.secret("grok-url")}.example.test/mcp"`,
      `headers = { "X-Key" = "${w.secret("grok-header")}" }`,
      "[mcp_servers.events]",
      'type = "sse"',
      `url = "https://${w.secret("grok-sse-url")}.example.test/sse"`,
      "",
    ].join("\n"),
  );
  await w.file(".grok/AGENTS.md", instructions.grok);
  await w.file(".grok/skills/own-skill/SKILL.md", "# Own\n");
  await w.file(".grok/agents/scout.md", "# Scout\n");
  await w.file(".grok/bundled/skills/code-review/SKILL.md", "# Code review\n");
  await w.file(".grok/bundled/agents/explore.md", "# Explore\n");
  await w.file(".grok/bundled/personas/reviewer.toml", 'instructions = "Review."\n');
  await w.file(".grok/bundled/roles/plan.toml", 'model = "synthetic"\n');
  await w.file(".grok/sessions/one/chat.jsonl", `${w.secret("grok-session")}\n`);
  if (grokStub) await w.file(".grok/bin/grok", stub("echo 'grok-build 1.3.0 (synthetic)'"), 0o755);
  else {
    await w.file(".grok/bin/grok-1.2.3", "binary", 0o755);
    await w.link(".grok/bin/grok", "grok-1.2.3");
  }
}

/** Cursor's folders, with Cursor's and Claude Code's install links. */
async function writeCursor(w: Writer) {
  await w.file(
    ".cursor/cli-config.json",
    JSON.stringify({
      version: 1,
      authInfo: {
        email: `${w.secret("cursor-email")}@example.test`,
        displayName: w.secret("cursor-display"),
        userId: 1,
      },
    }),
  );
  await w.file(
    ".cursor/mcp.json",
    JSON.stringify({
      mcpServers: {
        plan: {
          url: `https://${w.secret("cursor-url")}.example.test/mcp`,
          headers: { Authorization: `Bearer ${w.secret("cursor-header")}` },
        },
        tool: { command: "tool-server", env: { TOOL_KEY: w.secret("cursor-env") } },
      },
    }),
  );
  await w.file(".cursor/skills/own-cursor/SKILL.md", "# Own Cursor\n");
  await w.file(".cursor/skills-cursor/canvas/SKILL.md", "# Canvas\n");
  const cursor = ".local/share/cursor-agent/versions/2026.11.02-abc1234/cursor-agent";
  await w.file(cursor, "binary", 0o755);
  await w.link(".local/bin/cursor-agent", join(w.home, cursor));
  await w.file(".local/share/claude/versions/2.2.0", "binary", 0o755);
  await w.link(".local/bin/claude", join(w.home, ".local/share/claude/versions/2.2.0"));
}

function stub(body: string) {
  return `#!/bin/sh\n${body}\n`;
}

export const instructions = {
  codex: "# Codex rules\n\nKeep changes small.\nRun the tests.\n",
  claude: "# Claude rules\nAsk before deleting.",
  grok: "# Grok rules\n",
};

export function instruction(path: string, text: string) {
  const bytes = Buffer.byteLength(text);
  const newlines = text.split("\n").length - 1;
  return {
    path,
    bytes,
    lines: bytes === 0 ? 0 : newlines + (text.endsWith("\n") ? 0 : 1),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/** The promised size: regular files below the folder, links never followed, five largest parts. */
export async function folderSize(folder: string) {
  const parts = new Map<string, number>();
  let bytes = 0;
  let files = 0;
  const visit = async (path: string, part: string | null) => {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const info = await lstat(child);
      const top = part ?? name;
      if (info.isSymbolicLink()) continue;
      if (!parts.has(top)) parts.set(top, 0);
      if (info.isDirectory()) await visit(child, top);
      else if (info.isFile()) {
        bytes += info.size;
        files += 1;
        parts.set(top, parts.get(top)! + info.size);
      }
    }
  };
  await visit(folder, null);
  const largest = [...parts]
    .map(([name, size]) => ({ name, bytes: size }))
    .sort((left, right) => right.bytes - left.bytes || (left.name < right.name ? -1 : 1))
    .slice(0, 5);
  return { state: "done" as const, bytes, files, parts: largest };
}

const harnessFolders = [
  ".codex",
  ".claude",
  ".claude.json",
  ".cursor",
  ".grok",
  ".agents",
  ".local/bin",
  ".local/share/claude",
  ".local/share/cursor-agent",
];

/**
 * Hashes, sizes and modification times of every entry in the harness folders, with link
 * targets instead of bytes. Electron writes its own files elsewhere in the test home.
 */
export async function snapshot(
  home: string,
  folders = harnessFolders,
): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = async (path: string) => {
    const info = await lstat(path).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) entries[path] = `link ${await readlink(path)} ${info.mtimeMs}`;
    else if (info.isDirectory()) {
      entries[path] = `dir ${info.mtimeMs}`;
      for (const name of await readdir(path)) await visit(join(path, name));
    } else {
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      entries[path] = `file ${hash} ${info.size} ${info.mtimeMs}`;
    }
  };
  for (const folder of folders) await visit(join(home, folder));
  return entries;
}

export function notFound(id: HarnessReport["id"], name: string, home: string): HarnessReport {
  return {
    id,
    name,
    found: false,
    home,
    version: null,
    signIn: { state: "not-signed-in", method: null },
    size: null,
    skills: [],
    agents: [],
    mcpServers: [],
    instructions: [],
    unreadable: [],
  };
}

export const harness = (reply: HarnessesReply, id: HarnessReport["id"]) =>
  reply.machines[0]!.harnesses.find((report) => report.id === id)!;

export const withoutSize = (report: HarnessReport) => ({ ...report, size: undefined });
