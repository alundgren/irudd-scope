import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

function skillRoot() {
  const root = process.env.SCOPE_CLI_ROOT;
  if (!root || !isAbsolute(root))
    throw new Error("Use the standalone CLI installer before managing the Scope skill.");
  return root;
}

const bundles = [
  { name: "irudd-scope", directory: "skill" },
  { name: "irudd-scope-retro", directory: "retro-skill" },
];

async function links(root: string) {
  const home = process.env.SCOPE_SETUP_HOME ?? homedir();
  const candidates = bundles.flatMap(({ name, directory }) => {
    const shared = join(home, ".agents/skills", name);
    const bundle = join(root, directory);
    return [
      { path: shared, target: bundle, bundle, directory, optional: false },
      {
        path: join(home, ".claude/skills", name),
        target: shared,
        bundle,
        directory,
        optional: false,
      },
      {
        path: join(home, ".codex/skills", name),
        target: shared,
        bundle,
        directory,
        optional: true,
      },
    ];
  });
  const result = [];
  for (const candidate of candidates) {
    const entry = await lstat(candidate.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (entry && !entry.isSymbolicLink()) throw conflict(candidate.path);
    result.push({ ...candidate, existing: entry ? await readlink(candidate.path) : undefined });
  }
  return result;
}

function conflict(path: string) {
  return new Error(
    `${path} is a separate Scope skill installation. Move it aside, run irudd-scope skill install on this remote, then Retry update. Refresh or start a new agent session to reload skill guidance.`,
  );
}

function followsTarget(path: string, existing: string | undefined, target: string) {
  return existing !== undefined && resolve(dirname(path), existing) === resolve(target);
}

async function managedLink(root: string, path: string, target: string, directory: string) {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const installationRoot = metadata.scopeInstallation?.root;
  if (typeof installationRoot !== "string" || !isAbsolute(installationRoot)) return false;
  if (resolve(root) !== join(installationRoot, "current")) return false;
  const destination = resolve(dirname(path), target);
  if (destination === join(root, directory)) return true;
  const build = relative(join(installationRoot, "builds"), destination);
  return new RegExp(`^[0-9a-f-]{36}/${directory}$`).test(build);
}

export async function validateSkillLinks(root: string) {
  const entries = await links(root);
  for (const { path, target, existing, directory } of entries) {
    if (existing === undefined || followsTarget(path, existing, target)) continue;
    if (!(await managedLink(root, path, existing, directory))) throw conflict(path);
  }
  return entries;
}

export async function checkSkill() {
  const root = skillRoot();
  const entries = await validateSkillLinks(root);
  if (entries.every((entry) => entry.existing === undefined)) return false;
  for (const { path, target, existing, optional, bundle } of entries) {
    if (optional && existing === undefined) continue;
    if (!followsTarget(path, existing, target))
      throw new Error(
        `${path} does not follow the current Scope skill. Select Retry update to repair its link.`,
      );
    const expected = await readFile(join(bundle, "SKILL.md"));
    const content = await readFile(join(path, "SKILL.md")).catch(() => undefined);
    if (!content?.equals(expected))
      throw new Error(
        `${path}/SKILL.md does not match the bundled skill. Reinstall the remote tools and select Retry update.`,
      );
  }
  return true;
}

async function writeLinks(root: string) {
  const entries = await validateSkillLinks(root);
  for (const { path, target, existing, optional } of entries) {
    if ((optional && existing === undefined) || followsTarget(path, existing, target)) continue;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await symlink(target, temporary);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function syncSkill() {
  const root = skillRoot();
  const entries = await validateSkillLinks(root);
  // Removing all installed links opts out of the skill until an explicit install.
  if (entries.every((entry) => entry.existing === undefined)) return false;
  await writeLinks(root);
  return checkSkill();
}

export async function installSkill(remove = false) {
  const root = skillRoot();
  for (const { directory } of bundles) await readFile(join(root, directory, "SKILL.md"));
  if (remove) {
    for (const { path, existing } of await validateSkillLinks(root))
      if (existing !== undefined) await unlink(path);
  } else {
    await writeLinks(root);
    await checkSkill();
  }
  console.log(
    remove ? "Scope skills removed." : "Scope skills installed for Codex and Claude Code.",
  );
}
