import { join } from "node:path";
import {
  HARNESS_NAMES,
  MAX_HARNESS_ITEMS,
  MAX_HARNESS_MCP_SERVERS,
  type HarnessAgent,
  type HarnessId,
  type HarnessInstructionFile,
  type HarnessLocation,
  type HarnessReport,
  type HarnessSignIn,
  type HarnessSkill,
  type SharedSkillsReport,
} from "@irudd-scope/protocol/harnesses";
import {
  belowHome,
  entryBelowHome,
  fingerprintFile,
  isRealDirectory,
  isRegularFile,
  listFolder,
  parseJsonObject,
  readSmallFile,
} from "./files.ts";
import { mcpServers, parseTomlObject } from "./mcp.ts";
import {
  cleanVersion,
  detectVersion,
  findOnPath,
  linkTarget,
  versionAfterVersionsFolder,
  versionFromName,
  type VersionSource,
} from "./version.ts";

const CONFIG_LIMIT = 1024 * 1024;
/** ~/.claude.json also keeps per-project history and can grow; larger files are unknown. */
const CLAUDE_JSON_LIMIT = 16 * 1024 * 1024;

/** Paths are written from `~` with `/`, so reports never contain the account's folder name. */
const display = (...names: string[]) => ["~", ...names].join("/");

type Context = { home: string; path: string; signal: AbortSignal };
type Parsed = { value: Record<string, unknown> | null; unreadable: string[] };
type Facts = Pick<
  HarnessReport,
  "signIn" | "skills" | "agents" | "mcpServers" | "instructions" | "unreadable"
>;

type Definition = {
  id: HarnessId;
  /** The main folder's names below home. */
  folder: string[];
  version: (context: Context) => VersionSource;
  facts: (context: Context) => Promise<Facts>;
};

export type HarnessScanTarget = {
  id: HarnessId;
  /** The main folder, checked to be a real directory below home, or null when not found. */
  root: string | null;
  report: HarnessReport;
};

/**
 * Collects every fact except folder size. Reads stay inside each harness's own default
 * folders, never follow links and never write.
 */
export async function scanHarnesses(context: Context): Promise<HarnessScanTarget[]> {
  return Promise.all(
    definitions.map(async (definition): Promise<HarnessScanTarget> => {
      const base = {
        id: definition.id,
        name: HARNESS_NAMES[definition.id],
        home: display(...definition.folder),
      };
      if (!(await isRealDirectory(context.home, definition.folder)))
        return {
          id: definition.id,
          root: null,
          report: {
            ...base,
            found: false,
            version: null,
            signIn: { state: "not-signed-in", method: null },
            size: null,
            skills: [],
            agents: [],
            mcpServers: [],
            instructions: [],
            unreadable: [],
            truncated: false,
          },
        };
      const [facts, version] = await Promise.all([
        definition.facts(context),
        detectVersion(definition.version(context), context.path, context.signal),
      ]);
      const skills = facts.skills.slice(0, MAX_HARNESS_ITEMS);
      const agents = facts.agents.slice(0, MAX_HARNESS_ITEMS);
      const servers = facts.mcpServers.slice(0, MAX_HARNESS_MCP_SERVERS);
      return {
        id: definition.id,
        root: join(context.home, ...definition.folder),
        report: {
          ...base,
          found: true,
          version,
          size: { state: "pending" },
          ...facts,
          skills,
          agents,
          mcpServers: servers,
          truncated:
            skills.length < facts.skills.length ||
            agents.length < facts.agents.length ||
            servers.length < facts.mcpServers.length,
        },
      };
    }),
  );
}

/** A linked shared folder is reported as linked and its target is not listed. */
export async function scanSharedSkills(home: string): Promise<SharedSkillsReport> {
  const folder = [".agents", "skills"];
  const entry = await entryBelowHome(home, folder);
  const skills = (await skillsIn(home, folder, "own")).map(({ name, linked }) => ({
    name,
    linked,
  }));
  return {
    found: entry !== null && (entry.info.isDirectory() || entry.info.isSymbolicLink()),
    linked: entry?.info.isSymbolicLink() ?? false,
    home: display(...folder),
    skills: skills.slice(0, MAX_HARNESS_ITEMS),
    truncated: skills.length > MAX_HARNESS_ITEMS,
  };
}

const definitions: Definition[] = [
  {
    id: "codex",
    folder: [".codex"],
    version: ({ home }) => ({
      binary: "codex",
      fromLinks: async () =>
        versionFromName(await linkBelowHome(home, [".codex", "packages", "standalone", "current"])),
    }),
    facts: async ({ home }) => {
      const [auth, config] = await Promise.all([
        parsed(home, [".codex", "auth.json"], parseJsonObject),
        parsed(home, [".codex", "config.toml"], parseTomlObject),
      ]);
      const own = await listFolder(home, [".codex", "skills"]);
      // Codex keeps its bundled skills in a hidden folder inside the person's own skills.
      const system = own?.some((entry) => entry.name === ".system" && entry.kind === "directory");
      return {
        signIn: signInFrom(auth, (value) => {
          const mode = value.auth_mode;
          return typeof mode === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(mode) ? mode : null;
        }),
        mcpServers: mcpServers(config.value?.mcp_servers),
        skills: [
          ...(await skillsIn(home, [".codex", "skills"], "own")),
          ...(system ? await skillsIn(home, [".codex", "skills", ".system"], "bundled") : []),
        ],
        agents: await agentsIn(home, [".codex", "agents"], "own", "agent", ".toml"),
        instructions: await instructions(home, [
          [".codex", "AGENTS.md"],
          [".codex", "AGENTS.override.md"],
        ]),
        unreadable: [...auth.unreadable, ...config.unreadable],
      };
    },
  },
  {
    id: "claude-code",
    folder: [".claude"],
    version: ({ home, path }) => ({
      binary: "claude",
      fromLinks: async () =>
        versionAfterVersionsFolder(await linkBelowHome(home, [".local", "bin", "claude"])) ??
        versionAfterVersionsFolder(await pathLink("claude", path)),
    }),
    facts: async ({ home }) => {
      const state = await parsed(home, [".claude.json"], parseJsonObject, CLAUDE_JSON_LIMIT);
      return {
        signIn: signInFrom(
          state,
          () => "oauth",
          (value) => typeof value.oauthAccount === "object" && value.oauthAccount !== null,
        ),
        mcpServers: mcpServers(state.value?.mcpServers),
        skills: await skillsIn(home, [".claude", "skills"], "own"),
        agents: await agentsIn(home, [".claude", "agents"], "own", "agent", ".md"),
        instructions: await instructions(home, [[".claude", "CLAUDE.md"]]),
        unreadable: state.unreadable,
      };
    },
  },
  {
    id: "cursor",
    folder: [".cursor"],
    version: ({ home, path }) => ({
      binary: "cursor-agent",
      fromLinks: async () =>
        versionAfterVersionsFolder(
          (await pathLink("cursor-agent", path)) ??
            (await linkBelowHome(home, [".local", "bin", "cursor-agent"])),
        ) ?? (await newestVersionFolder(home, CURSOR_VERSIONS)),
    }),
    facts: async ({ home }) => {
      const [config, mcp] = await Promise.all([
        parsed(home, [".cursor", "cli-config.json"], parseJsonObject),
        parsed(home, [".cursor", "mcp.json"], parseJsonObject),
      ]);
      return {
        signIn: signInFrom(
          config,
          () => null,
          (value) => typeof value.authInfo === "object" && value.authInfo !== null,
        ),
        mcpServers: mcpServers(mcp.value?.mcpServers),
        skills: [
          ...(await skillsIn(home, [".cursor", "skills"], "own")),
          ...(await skillsIn(home, [".cursor", "skills-cursor"], "bundled")),
        ],
        agents: [],
        instructions: [],
        unreadable: [...config.unreadable, ...mcp.unreadable],
      };
    },
  },
  {
    id: "grok",
    folder: [".grok"],
    version: ({ home }) => ({
      binary: "grok",
      extraPath: [join(home, ".grok", "bin")],
      fromLinks: async () =>
        versionFromName(await linkBelowHome(home, [".grok", "bin", "grok"]), "grok-"),
    }),
    facts: async ({ home }) => {
      const bundled = [".grok", "bundled"];
      const config = await parsed(home, [".grok", "config.toml"], parseTomlObject);
      // Grok's sign-in is the presence of auth.json; a link or other entry there is unknown.
      const auth = (await entryBelowHome(home, [".grok", "auth.json"]))?.info;
      const authUnreadable = auth && !auth.isFile() ? [display(".grok", "auth.json")] : [];
      return {
        signIn: {
          state: !auth ? "not-signed-in" : auth.isFile() ? "signed-in" : "unknown",
          method: null,
        },
        mcpServers: mcpServers(config.value?.mcp_servers),
        skills: [
          ...(await skillsIn(home, [".grok", "skills"], "own")),
          ...(await skillsIn(home, [...bundled, "skills"], "bundled")),
        ],
        agents: [
          ...(await agentsIn(home, [".grok", "agents"], "own", "agent", ".md")),
          ...(await agentsIn(home, [...bundled, "agents"], "bundled", "agent", ".md")),
          ...(await agentsIn(home, [...bundled, "personas"], "bundled", "persona", ".toml")),
          ...(await agentsIn(home, [...bundled, "roles"], "bundled", "role", ".toml")),
        ],
        instructions: await instructions(home, [[".grok", "AGENTS.md"]]),
        unreadable: [...authUnreadable, ...config.unreadable],
      };
    },
  },
];

/**
 * Cursor's own install folder. Its Windows installer copies launchers into
 * %LOCALAPPDATA%\cursor-agent instead of linking them, so only the folder names tell the version.
 */
const CURSOR_VERSIONS =
  process.platform === "win32"
    ? ["AppData", "Local", "cursor-agent", "versions"]
    : [".local", "share", "cursor-agent", "versions"];

/** The newest version folder, skipping the installer's `.new` and `.previous` update folders. */
async function newestVersionFolder(home: string, names: string[]): Promise<string | null> {
  const versions = ((await listFolder(home, names)) ?? [])
    .filter((entry) => entry.kind === "directory" && !/\.(?:new|previous)$/.test(entry.name))
    .map((entry) => cleanVersion(entry.name))
    .filter((version) => version !== null);
  return (
    versions.sort((left, right) => right.localeCompare(left, "en", { numeric: true }))[0] ?? null
  );
}

async function pathLink(name: string, path: string): Promise<string | null> {
  const binary = await findOnPath(name, path);
  return binary ? linkTarget(binary) : null;
}

async function linkBelowHome(home: string, names: string[]): Promise<string | null> {
  const path = await belowHome(home, names);
  return path ? linkTarget(path) : null;
}

async function parsed(
  home: string,
  names: string[],
  parse: (text: string) => Record<string, unknown> | null,
  limit = CONFIG_LIMIT,
): Promise<Parsed> {
  const read = await readSmallFile(home, names, limit);
  if (read.kind === "missing") return { value: null, unreadable: [] };
  const value = read.kind === "text" ? parse(read.text) : null;
  return { value, unreadable: value ? [] : [display(...names)] };
}

/**
 * A sign-in file that exists but cannot be parsed gives unknown. `present` decides whether a
 * parsed file shows a sign-in; by default the file's presence is enough.
 */
function signInFrom(
  file: Parsed,
  method: (value: Record<string, unknown>) => string | null,
  present: (value: Record<string, unknown>) => boolean = () => true,
): HarnessSignIn {
  if (file.unreadable.length > 0) return { state: "unknown", method: null };
  if (!file.value || !present(file.value)) return { state: "not-signed-in", method: null };
  return { state: "signed-in", method: method(file.value) };
}

/**
 * A skill is a folder holding SKILL.md, or a link, which is listed by name without reading
 * its target. Hidden entries such as Codex's bundled `.system` folder are not skills here.
 * One more than the limit is kept so the caller can tell the list was cut.
 */
async function skillsIn(
  home: string,
  folder: string[],
  location: HarnessLocation,
): Promise<HarnessSkill[]> {
  const entries = (await listFolder(home, folder)) ?? [];
  const skills: HarnessSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.length > 255) continue;
    if (entry.kind === "link") skills.push({ name: entry.name, location, linked: true });
    else if (
      entry.kind === "directory" &&
      (await isRegularFile(home, [...folder, entry.name, "SKILL.md"]))
    )
      skills.push({ name: entry.name, location, linked: false });
    if (skills.length > MAX_HARNESS_ITEMS) break;
  }
  return skills;
}

async function agentsIn(
  home: string,
  folder: string[],
  location: HarnessLocation,
  kind: HarnessAgent["kind"],
  extension: string,
): Promise<HarnessAgent[]> {
  const entries = (await listFolder(home, folder)) ?? [];
  return entries
    .filter(
      (entry) =>
        (entry.kind === "file" || entry.kind === "link") &&
        !entry.name.startsWith(".") &&
        entry.name.endsWith(extension) &&
        entry.name.length > extension.length,
    )
    .map((entry) => ({
      name: entry.name.slice(0, -extension.length).slice(0, 255),
      location,
      linked: entry.kind === "link",
      kind,
    }))
    .slice(0, MAX_HARNESS_ITEMS + 1);
}

/** A linked instruction file is reported without reading its target. */
async function instructions(home: string, files: string[][]): Promise<HarnessInstructionFile[]> {
  const found: HarnessInstructionFile[] = [];
  for (const names of files) {
    const path = display(...names);
    const entry = await entryBelowHome(home, names);
    if (entry?.info.isSymbolicLink())
      found.push({ path, linked: true, bytes: null, lines: null, sha256: null });
    const fingerprint = entry?.info.isFile() ? await fingerprintFile(home, names) : null;
    if (fingerprint) found.push({ path, linked: false, ...fingerprint });
  }
  return found;
}
