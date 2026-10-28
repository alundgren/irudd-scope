import { join } from "node:path";
import {
  HARNESS_NAMES,
  MAX_HARNESS_ITEMS,
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
  fingerprintFile,
  isRealDirectory,
  isRegularFile,
  listFolder,
  parseJsonObject,
  readSmallFile,
} from "./files.ts";
import { mcpServers, parseTomlObject } from "./mcp.ts";
import {
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

type Context = { home: string; path: string };
type Parsed = { value: Record<string, unknown> | null; unreadable: string[] };
type Facts = Omit<HarnessReport, "id" | "name" | "found" | "home" | "size" | "version">;

type Definition = {
  id: HarnessId;
  /** The main folder's names below home. */
  folder: string[];
  version: (context: Context) => VersionSource;
  facts: (context: Context) => Promise<Facts>;
};

export type HarnessScanTarget = {
  id: HarnessId;
  root: string;
  report: HarnessReport;
};

/**
 * Collects every fact except folder size. Reads stay inside each harness's own default
 * folders, never follow links and never write.
 */
export async function scanHarnesses(context: Context): Promise<HarnessScanTarget[]> {
  return Promise.all(
    definitions.map(async (definition): Promise<HarnessScanTarget> => {
      const root = join(context.home, ...definition.folder);
      const base = {
        id: definition.id,
        name: HARNESS_NAMES[definition.id],
        home: display(...definition.folder),
      };
      if (!(await isRealDirectory(root)))
        return {
          id: definition.id,
          root,
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
          },
        };
      const [facts, version] = await Promise.all([
        definition.facts(context),
        detectVersion(definition.version(context), context.path),
      ]);
      return {
        id: definition.id,
        root,
        report: { ...base, found: true, version, size: { state: "pending" }, ...facts },
      };
    }),
  );
}

export async function scanSharedSkills(home: string): Promise<SharedSkillsReport> {
  const folder = join(home, ".agents", "skills");
  return {
    found: await isRealDirectory(folder),
    home: display(".agents", "skills"),
    skills: (await skillsIn(folder, "own")).map(({ name, linked }) => ({ name, linked })),
  };
}

const definitions: Definition[] = [
  {
    id: "codex",
    folder: [".codex"],
    version: ({ home }) => ({
      binary: "codex",
      fromLinks: async () =>
        versionFromName(
          await linkTarget(join(home, ".codex", "packages", "standalone", "current")),
        ),
    }),
    facts: async ({ home }) => {
      const root = join(home, ".codex");
      const [auth, config] = await Promise.all([
        parsed(join(root, "auth.json"), display(".codex", "auth.json"), parseJsonObject),
        parsed(join(root, "config.toml"), display(".codex", "config.toml"), parseTomlObject),
      ]);
      return {
        signIn: signInFrom(auth, (value) => {
          const mode = value.auth_mode;
          return typeof mode === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(mode) ? mode : null;
        }),
        mcpServers: mcpServers(config.value?.mcp_servers),
        skills: [
          ...(await skillsIn(join(root, "skills"), "own")),
          ...(await skillsIn(join(root, "skills", ".system"), "bundled")),
        ],
        agents: await agentsIn(join(root, "agents"), "own", "agent", ".toml"),
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
        versionAfterVersionsFolder(await linkTarget(join(home, ".local", "bin", "claude"))) ??
        versionAfterVersionsFolder(await pathLink("claude", path)),
    }),
    facts: async ({ home }) => {
      const root = join(home, ".claude");
      const state = await parsed(
        join(home, ".claude.json"),
        display(".claude.json"),
        parseJsonObject,
        CLAUDE_JSON_LIMIT,
      );
      return {
        signIn: signInFrom(
          state,
          () => "oauth",
          (value) => typeof value.oauthAccount === "object" && value.oauthAccount !== null,
        ),
        mcpServers: mcpServers(state.value?.mcpServers),
        skills: await skillsIn(join(root, "skills"), "own"),
        agents: await agentsIn(join(root, "agents"), "own", "agent", ".md"),
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
            (await linkTarget(join(home, ".local", "bin", "cursor-agent"))),
        ),
    }),
    facts: async ({ home }) => {
      const root = join(home, ".cursor");
      const [config, mcp] = await Promise.all([
        parsed(
          join(root, "cli-config.json"),
          display(".cursor", "cli-config.json"),
          parseJsonObject,
        ),
        parsed(join(root, "mcp.json"), display(".cursor", "mcp.json"), parseJsonObject),
      ]);
      return {
        signIn: signInFrom(
          config,
          () => null,
          (value) => typeof value.authInfo === "object" && value.authInfo !== null,
        ),
        mcpServers: mcpServers(mcp.value?.mcpServers),
        skills: [
          ...(await skillsIn(join(root, "skills"), "own")),
          ...(await skillsIn(join(root, "skills-cursor"), "bundled")),
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
        versionFromName(await linkTarget(join(home, ".grok", "bin", "grok")), "grok-"),
    }),
    facts: async ({ home }) => {
      const root = join(home, ".grok");
      const bundled = join(root, "bundled");
      const config = await parsed(
        join(root, "config.toml"),
        display(".grok", "config.toml"),
        parseTomlObject,
      );
      const signedIn = await isRegularFile(join(root, "auth.json"));
      return {
        signIn: { state: signedIn ? "signed-in" : "not-signed-in", method: null },
        mcpServers: mcpServers(config.value?.mcp_servers),
        skills: [
          ...(await skillsIn(join(root, "skills"), "own")),
          ...(await skillsIn(join(bundled, "skills"), "bundled")),
        ],
        agents: [
          ...(await agentsIn(join(root, "agents"), "own", "agent", ".md")),
          ...(await agentsIn(join(bundled, "agents"), "bundled", "agent", ".md")),
          ...(await agentsIn(join(bundled, "personas"), "bundled", "persona", ".toml")),
          ...(await agentsIn(join(bundled, "roles"), "bundled", "role", ".toml")),
        ].slice(0, MAX_HARNESS_ITEMS),
        instructions: await instructions(home, [[".grok", "AGENTS.md"]]),
        unreadable: config.unreadable,
      };
    },
  },
];

async function pathLink(name: string, path: string): Promise<string | null> {
  const binary = await findOnPath(name, path);
  return binary ? linkTarget(binary) : null;
}

async function parsed(
  file: string,
  shown: string,
  parse: (text: string) => Record<string, unknown> | null,
  limit = CONFIG_LIMIT,
): Promise<Parsed> {
  const read = await readSmallFile(file, limit);
  if (read.kind === "missing") return { value: null, unreadable: [] };
  const value = read.kind === "text" ? parse(read.text) : null;
  return { value, unreadable: value ? [] : [shown] };
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
 */
async function skillsIn(folder: string, location: HarnessLocation): Promise<HarnessSkill[]> {
  const entries = (await listFolder(folder)) ?? [];
  const skills: HarnessSkill[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.length > 255) continue;
    if (entry.kind === "link") skills.push({ name: entry.name, location, linked: true });
    else if (
      entry.kind === "directory" &&
      (await isRegularFile(join(folder, entry.name, "SKILL.md")))
    )
      skills.push({ name: entry.name, location, linked: false });
    if (skills.length >= MAX_HARNESS_ITEMS) break;
  }
  return skills;
}

async function agentsIn(
  folder: string,
  location: HarnessLocation,
  kind: HarnessAgent["kind"],
  extension: string,
): Promise<HarnessAgent[]> {
  const entries = (await listFolder(folder)) ?? [];
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
    .slice(0, MAX_HARNESS_ITEMS);
}

async function instructions(home: string, files: string[][]): Promise<HarnessInstructionFile[]> {
  const found: HarnessInstructionFile[] = [];
  for (const names of files) {
    const fingerprint = await fingerprintFile(join(home, ...names));
    if (fingerprint) found.push({ path: display(...names), ...fingerprint });
  }
  return found;
}
