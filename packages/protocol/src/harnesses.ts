import { Schema } from "effect";

/** Agent command routes on the desktop's artifact API. */
export const HARNESSES_ROUTES = {
  read: "/v1/harnesses",
  scan: "/v1/harnesses/scan",
} as const;
/**
 * One machine's scan as JSON, as returned and as saved in desktop.db. The scanner shortens the
 * longest lists and marks their reports truncated to stay within it.
 */
export const MAX_HARNESS_SCAN_BYTES = 256 * 1024;
/** A read can later hold several machines; each is bounded by MAX_HARNESS_SCAN_BYTES. */
export const MAX_HARNESSES_REPLY_BYTES = 16 * 1024 * 1024;
export const MAX_HARNESSES_REQUEST_BYTES = 4096;
export const MAX_HARNESS_ITEMS = 1000;
export const MAX_HARNESS_MCP_SERVERS = 500;

export const HARNESS_IDS = ["codex", "claude-code", "cursor", "grok"] as const;
export const HarnessId = Schema.Literals(HARNESS_IDS);
export type HarnessId = typeof HarnessId.Type;
export const HARNESS_NAMES: Record<HarnessId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  grok: "Grok Build",
};

/** `local`, `remote:ID` for a paired remote, or `guest:ID` for a guest desktop that shares. */
export const HarnessMachine = Schema.String.check(
  Schema.isPattern(
    /^(?:local|remote:[a-f0-9-]{36}|guest:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  ),
);
export type HarnessMachine = typeof HarnessMachine.Type;

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255));
/** A path below the scanned account's home, written as `~/` followed by `/`-separated names. */
const HomePath = Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^~(?:\/.+)?$/));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Time = Schema.String.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
);

/** `own` folders hold what the person added; `bundled` folders ship with the harness. */
export const HarnessLocation = Schema.Literals(["own", "bundled"]);
export type HarnessLocation = typeof HarnessLocation.Type;

export const HarnessSkill = Schema.Struct({
  name: Name,
  location: HarnessLocation,
  /** The entry is a symbolic link. Scope lists it by its link name and never reads its target. */
  linked: Schema.Boolean,
});
export type HarnessSkill = typeof HarnessSkill.Type;

export const HarnessAgent = Schema.Struct({
  name: Name,
  location: HarnessLocation,
  linked: Schema.Boolean,
  kind: Schema.Literals(["agent", "persona", "role"]),
});
export type HarnessAgent = typeof HarnessAgent.Type;

export const HarnessMcpServer = Schema.Struct({
  name: Name,
  transport: Schema.Literals(["stdio", "http", "sse", "unknown"]),
  location: HarnessLocation,
});
export type HarnessMcpServer = typeof HarnessMcpServer.Type;

/** A linked instruction file is reported with null facts; its target is never read. */
export const HarnessInstructionFile = Schema.Struct({
  path: HomePath,
  linked: Schema.Boolean,
  bytes: Schema.NullOr(Count),
  lines: Schema.NullOr(Count),
  sha256: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
});
export type HarnessInstructionFile = typeof HarnessInstructionFile.Type;

export const HarnessSignIn = Schema.Struct({
  state: Schema.Literals(["signed-in", "not-signed-in", "unknown"]),
  method: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/))),
});
export type HarnessSignIn = typeof HarnessSignIn.Type;

export const HarnessFolderSize = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({
    state: Schema.Literal("done"),
    bytes: Count,
    files: Count,
    parts: Schema.Array(Schema.Struct({ name: Name, bytes: Count })).check(Schema.isMaxLength(5)),
  }),
]);
export type HarnessFolderSize = typeof HarnessFolderSize.Type;

export const HarnessReport = Schema.Struct({
  id: HarnessId,
  name: Name,
  found: Schema.Boolean,
  home: HomePath,
  version: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  signIn: HarnessSignIn,
  size: Schema.NullOr(HarnessFolderSize),
  skills: Schema.Array(HarnessSkill).check(Schema.isMaxLength(MAX_HARNESS_ITEMS)),
  agents: Schema.Array(HarnessAgent).check(Schema.isMaxLength(MAX_HARNESS_ITEMS)),
  mcpServers: Schema.Array(HarnessMcpServer).check(Schema.isMaxLength(MAX_HARNESS_MCP_SERVERS)),
  instructions: Schema.Array(HarnessInstructionFile).check(Schema.isMaxLength(8)),
  /** Files that exist but could not be read or parsed; their facts are reported as unknown. */
  unreadable: Schema.Array(HomePath).check(Schema.isMaxLength(16)),
  /** Some skills, agents or MCP servers were left out to stay within the item and size limits. */
  truncated: Schema.Boolean,
});
export type HarnessReport = typeof HarnessReport.Type;

export const SharedSkillsReport = Schema.Struct({
  found: Schema.Boolean,
  /** The folder itself is a symbolic link. Scope lists nothing inside it. */
  linked: Schema.Boolean,
  home: HomePath,
  skills: Schema.Array(Schema.Struct({ name: Name, linked: Schema.Boolean })).check(
    Schema.isMaxLength(MAX_HARNESS_ITEMS),
  ),
  truncated: Schema.Boolean,
});
export type SharedSkillsReport = typeof SharedSkillsReport.Type;

export const HarnessScan = Schema.Struct({
  machine: HarnessMachine,
  scannedAt: Time,
  harnesses: Schema.Array(HarnessReport).check(Schema.isMaxLength(HARNESS_IDS.length)),
  sharedSkills: SharedSkillsReport,
});
export type HarnessScan = typeof HarnessScan.Type;

export const HarnessesReply = Schema.Struct({
  machines: Schema.Array(HarnessScan).check(Schema.isMaxLength(256)),
});
export type HarnessesReply = typeof HarnessesReply.Type;

/** Machines a read or scan can name. This Scope reads only the desktop's own computer. */
export const HarnessesTarget = Schema.Literal("local");
export type HarnessesTarget = typeof HarnessesTarget.Type;
export const HarnessesScanRequest = Schema.Struct({ machine: HarnessesTarget });
export type HarnessesScanRequest = typeof HarnessesScanRequest.Type;

export const HarnessesGuide = {
  purpose:
    "Report the coding agent harnesses installed for this account: Codex, Claude Code, Cursor and Grok Build, plus the shared skill folder ~/.agents/skills. Scope only reads. It never changes, moves or deletes a harness file, never runs an agent and never returns secrets.",
  commands: {
    scan: "irudd-scope harnesses scan [--machine local]",
    read: "irudd-scope harnesses read [--machine local]",
    guide: "irudd-scope harnesses guide",
  },
  machines:
    "--machine defaults to local, the computer running the Scope desktop. Other values fail. The command needs the desktop open; it is never queued.",
  output:
    "Both commands print JSON {machines:[{machine, scannedAt, harnesses, sharedSkills}]}. scan starts a new scan and returns as soon as every fact except folder sizes is known. read returns the latest scan; the desktop also scans when it starts. The desktop saves the latest scan per machine.",
  fields: {
    id: "codex, claude-code, cursor or grok.",
    name: "Codex, Claude Code, Cursor or Grok Build.",
    found:
      "true when the harness's main folder exists as a real folder. A missing or linked main folder gives found false and empty facts. Scope never reads through a linked folder anywhere below home.",
    home: "The main folder, written from ~.",
    version:
      "From the install link target: Codex ~/.codex/packages/standalone/current -> releases/VERSION-TRIPLE; Claude Code ~/.local/bin/claude -> versions/VERSION; Cursor cursor-agent on PATH -> versions/VERSION/; Grok ~/.grok/bin/grok -> grok-VERSION. Links are read, never followed. Only when no such link exists does Scope run the binary on PATH once with --version and a five-second limit, as a last resort. null when no binary is found, the call fails, or the only launcher is a Windows .cmd file. Update-check caches are never used.",
    signIn:
      "state is signed-in, not-signed-in or unknown (a sign-in file exists but cannot be read). method comes only from non-secret fields: Codex auth_mode in ~/.codex/auth.json, oauth for Claude Code's oauthAccount in ~/.claude.json, null for Cursor (authInfo in ~/.cursor/cli-config.json) and Grok (~/.grok/auth.json present).",
    size: "pending while Scope counts in the background, then {state: done, bytes, files, parts}. bytes and files total the regular files below the main folder; links are never followed and add nothing. parts are the five largest top-level entries. null when not found. Read again to see the final size.",
    skills:
      "Skill folders by name. location own is the person's folder, bundled ships with the harness. linked true means the entry is a symbolic link; its target is not read.",
    agents:
      "Agent definition files by name without extension, with location, linked and kind (agent, persona or role).",
    mcpServers:
      "MCP server names with transport stdio, http, sse or unknown. Commands, URLs, headers and environment values are never returned.",
    instructions:
      "Global instruction files with their ~ path, linked, bytes, line count and sha256. A linked file has linked true and null bytes, lines and sha256; its target is not read.",
    unreadable:
      "Files that exist but could not be read or parsed, for example an invalid config.toml; facts from them are unknown.",
    truncated:
      "true when some skills, agents or MCP servers were left out: each list keeps at most 1000 entries (500 MCP servers) and a whole scan at most 256 KiB, so the longest lists are shortened first.",
    sharedSkills:
      "~/.agents/skills, reported once per machine with found, linked (the folder itself is a link, so nothing inside it is listed), skill names with linked flags, and truncated.",
  },
  folders: {
    codex:
      "~/.codex: auth.json, config.toml [mcp_servers], AGENTS.md and AGENTS.override.md, own skills ~/.codex/skills, bundled skills ~/.codex/skills/.system, own agents ~/.codex/agents/*.toml.",
    "claude-code":
      "~/.claude and ~/.claude.json: oauthAccount and top-level mcpServers in ~/.claude.json, ~/.claude/CLAUDE.md, own skills ~/.claude/skills, own agents ~/.claude/agents/*.md.",
    cursor:
      "~/.cursor: cli-config.json authInfo, mcp.json mcpServers, own skills ~/.cursor/skills, bundled skills ~/.cursor/skills-cursor. Cursor's install folder ~/.local/share/cursor-agent is used for its version only.",
    grok: "~/.grok: auth.json, config.toml [mcp_servers], AGENTS.md, own skills ~/.grok/skills and agents ~/.grok/agents/*.md, bundled ~/.grok/bundled/skills, agents, personas and roles.",
    shared: "~/.agents/skills.",
  },
  rules: [
    "Each harness lists only its own folders and the folders it ships with. Scope makes no claim about which harness loads another harness's folders or ~/.agents/skills; check each harness's documentation.",
    "Scope never reads session or chat contents; session folders only add to the size.",
    "Scope never returns token values, API keys, MCP environment or header values, MCP URLs, or account emails and names.",
  ],
} as const;
