import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

/** `.git` is never shown, listed, or watched. */
export const GIT_DIRECTORY = ".git";

type Level = { directory: string; rules: Ignore };

async function readRules(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * `.gitignore` rules for one directory: the folder's `.git/info/exclude` and every
 * `.gitignore` from the folder down to the directory. Deeper files win, as in Git.
 */
export class IgnoreRules {
  private readonly levels: readonly Level[];
  private constructor(levels: readonly Level[]) {
    this.levels = levels;
  }

  static async load(root: string, directory: string): Promise<IgnoreRules> {
    const parts = directory ? directory.split("/") : [];
    const levels: Level[] = [];
    const exclude = await readRules(join(root, GIT_DIRECTORY, "info", "exclude"));
    if (exclude) levels.push({ directory: "", rules: ignore().add(exclude) });
    for (let depth = 0; depth <= parts.length; depth++) {
      const current = parts.slice(0, depth).join("/");
      const text = await readRules(join(root, ...parts.slice(0, depth), ".gitignore"));
      if (text) levels.push({ directory: current, rules: ignore().add(text) });
    }
    return new IgnoreRules(levels);
  }

  /** Rules for a child directory, reusing this directory's levels. */
  async child(root: string, directory: string): Promise<IgnoreRules> {
    const text = await readRules(join(root, ...directory.split("/"), ".gitignore"));
    return new IgnoreRules(
      text ? [...this.levels, { directory, rules: ignore().add(text) }] : this.levels,
    );
  }

  /** Whether a path, given relative to the folder, matches the rules. */
  ignores(path: string, directory: boolean): boolean {
    for (let index = this.levels.length - 1; index >= 0; index--) {
      const level = this.levels[index]!;
      const prefix = level.directory ? `${level.directory}/` : "";
      if (prefix && !path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      if (!relative) continue;
      const result = level.rules.test(directory ? `${relative}/` : relative);
      if (result.ignored) return true;
      if (result.unignored) return false;
    }
    return false;
  }
}

function parent(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Cached ignore decisions for a watched folder. Clear it when ignore files change. */
export class IgnoreFilter {
  private readonly rules = new Map<string, Promise<IgnoreRules>>();
  private readonly ignoredDirectories = new Map<string, Promise<boolean>>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  clear() {
    this.rules.clear();
    this.ignoredDirectories.clear();
  }

  private rulesFor(directory: string): Promise<IgnoreRules> {
    let rules = this.rules.get(directory);
    if (!rules) {
      if (this.rules.size > 10_000) this.clear();
      rules = directory
        ? this.rulesFor(parent(directory)).then((above) => above.child(this.root, directory))
        : IgnoreRules.load(this.root, "");
      this.rules.set(directory, rules);
    }
    return rules;
  }

  private directoryIgnored(directory: string): Promise<boolean> {
    if (!directory) return Promise.resolve(false);
    let ignored = this.ignoredDirectories.get(directory);
    if (!ignored) {
      if (this.ignoredDirectories.size > 10_000) this.clear();
      ignored = this.directoryIgnored(parent(directory)).then(
        async (above) => above || (await this.rulesFor(parent(directory))).ignores(directory, true),
      );
      this.ignoredDirectories.set(directory, ignored);
    }
    return ignored;
  }

  async ignores(path: string, directory: boolean): Promise<boolean> {
    const above = parent(path);
    if (await this.directoryIgnored(above)) return true;
    return (await this.rulesFor(above)).ignores(path, directory);
  }
}
