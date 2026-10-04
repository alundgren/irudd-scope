import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

const ObjectData = Schema.Record(Schema.String, Schema.Unknown);
const ScopeSource = Schema.Struct({
  source: Schema.Literal("alundgren/irudd-scope"),
  sourceType: Schema.Literal("github"),
  skillPath: Schema.String,
});
type Registry = { data: typeof ObjectData.Type; skills: Record<string, unknown> };
type ChangedLink = { path: string; existing?: string; backup?: string };

const names = ["irudd-scope", "irudd-scope-retro"];

function missing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
}

export class AgentSkills {
  constructor(
    private readonly root: string,
    private readonly home: string,
  ) {}

  private paths() {
    return names.flatMap((name) => {
      const shared = join(this.home, ".agents/skills", name);
      const bundle = join(this.root, "current/Scope.app/Contents/Resources/app/skills", name);
      return [
        { name, path: shared, target: bundle, optional: false, shared: true },
        {
          name,
          path: join(this.home, ".claude/skills", name),
          target: shared,
          optional: false,
          shared: false,
        },
        {
          name,
          path: join(this.home, ".codex/skills", name),
          target: shared,
          optional: true,
          shared: false,
        },
      ];
    });
  }

  private lockPath() {
    return join(this.home, ".agents/.skill-lock.json");
  }

  private async registry() {
    const content = await readFile(this.lockPath(), "utf8").catch(missing);
    if (content === undefined) return undefined;
    const data = Schema.decodeUnknownSync(ObjectData)(JSON.parse(content));
    const skills = { ...Schema.decodeUnknownSync(ObjectData)(data.skills) };
    return { data, skills };
  }

  private isLegacy(registry: Registry | undefined, name: string) {
    const skill = registry?.skills[name];
    return Schema.is(ScopeSource)(skill) && skill.skillPath === `.agents/skills/${name}/SKILL.md`;
  }

  private async entries() {
    const registry = await this.registry();
    return Promise.all(
      this.paths().map(async (entry) => {
        const stat = await lstat(entry.path).catch(missing);
        const existing = stat?.isSymbolicLink() ? await readlink(entry.path) : undefined;
        const follows =
          existing !== undefined && resolve(dirname(entry.path), existing) === entry.target;
        const legacy = Boolean(
          stat?.isDirectory() && entry.shared && this.isLegacy(registry, entry.name),
        );
        if (stat && !follows && !legacy) {
          throw new Error(
            `${entry.path} is a separate skill installation. Move it aside, then install the Scope skills in Settings.`,
          );
        }
        return { ...entry, existing, present: Boolean(stat), follows, legacy };
      }),
    );
  }

  async installed() {
    if (
      !(await access(
        join(this.root, "current/Scope.app/Contents/Resources/app/skills/irudd-scope/SKILL.md"),
      ).then(
        () => true,
        () => false,
      ))
    )
      return false;
    return (
      await Promise.all(
        this.paths().map(async (entry) => {
          const existing = await readlink(entry.path).catch(() => undefined);
          if (entry.optional && existing === undefined && !(await lstat(entry.path).catch(missing)))
            return true;
          if (existing === undefined || resolve(dirname(entry.path), existing) !== entry.target)
            return false;
          return access(join(entry.path, "SKILL.md")).then(
            () => true,
            () => false,
          );
        }),
      )
    ).every(Boolean);
  }

  private async link(path: string, target: string) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await symlink(target, temporary);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async forgetLegacy() {
    const registry = await this.registry();
    if (!registry || !names.some((name) => this.isLegacy(registry, name))) return;
    for (const name of names) if (this.isLegacy(registry, name)) delete registry.skills[name];
    const temporary = `${this.lockPath()}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ ...registry.data, skills: registry.skills }, null, 2) + "\n",
        { mode: 0o600 },
      );
      await rename(temporary, this.lockPath());
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async sync() {
    const entries = await this.entries();
    // Removing every link opts out until the person installs the skills again.
    if (!entries.some((entry) => entry.present)) return "";
    if (await this.installed()) return "";
    return this.install();
  }

  async install() {
    for (const name of names)
      await access(
        join(this.root, "current/Scope.app/Contents/Resources/app/skills", name, "SKILL.md"),
      );
    const entries = await this.entries();
    const changed: ChangedLink[] = [];
    const backups: string[] = [];
    try {
      for (const entry of entries) {
        if (entry.follows || (entry.optional && !entry.present)) continue;
        let backup: string | undefined;
        if (entry.legacy) {
          backup = join(this.root, "skill-backups", `${entry.name}-${randomUUID()}`);
          await mkdir(dirname(backup), { recursive: true });
          await rename(entry.path, backup);
          backups.push(backup);
        }
        changed.push({ path: entry.path, existing: entry.existing, backup });
        await this.link(entry.path, entry.target);
      }
      if (!(await this.installed()))
        throw new Error("Scope skill links could not be verified. Select Repair skill to retry.");
      await this.forgetLegacy();
    } catch (error) {
      await this.restore(changed, error);
      throw error;
    }
    return `Scope skills now update with the app. Refresh or start a new agent session to reload them.${backups.length ? ` Previous copies saved in ${join(this.root, "skill-backups")}.` : ""}`;
  }

  private async restore(changed: ChangedLink[], originalError: unknown) {
    const errors: unknown[] = [];
    for (const entry of changed.reverse()) {
      try {
        await rm(entry.path, { force: true });
        if (entry.backup) await rename(entry.backup, entry.path);
        else if (entry.existing !== undefined) await this.link(entry.path, entry.existing);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        [originalError, ...errors],
        `Could not restore every skill link. Previous copies remain in ${join(this.root, "skill-backups")}.`,
      );
  }

  async remove() {
    const entries = await this.entries();
    if (entries.some((entry) => entry.legacy))
      throw new Error("Select Repair skill before removing the older skill installation.");
    for (const entry of entries) if (entry.present) await unlink(entry.path);
    return "Scope skills removed. App updates will leave them uninstalled.";
  }
}
