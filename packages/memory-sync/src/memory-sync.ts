import { access, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MemoryCommands, SyncError } from "./commands.ts";
import {
  MEMORY_BUNDLE_NAME,
  MEMORY_CONFLICT_BRANCH_PREFIX,
  disabledMemory,
  type MemoryConfiguration,
  type MemoryConflict,
  type MemoryMachineStatus,
} from "@irudd-scope/protocol/memory";

export const MEMORY_SYNC_INTERVAL_MS = 5 * 60_000;
export const OKF_UPGRADE_INTERVAL_MS = 24 * 60 * 60_000;
const STALE_LOCK_MS = 15 * 60_000;
const STALE_INDEX_LOCK_MS = 10 * 60_000;

export function defaultMemoryRoot(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.SCOPE_MEMORY_DIR ?? join(homedir(), ".local/share/irudd-scope/memory"));
}

export type MemorySyncOptions = {
  root: string;
  machine: string;
  onChange?: (status: MemoryMachineStatus) => void;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  upgradeIntervalMs?: number;
  now?: () => Date;
};

export class MemorySync {
  private configuration = disabledMemory();
  private current: MemoryMachineStatus;
  private running?: { controller: AbortController; task: Promise<void> };
  private again = false;
  private loop?: Promise<void>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private upgradeTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly commands: MemoryCommands;
  private readonly now: () => Date;

  constructor(private readonly options: MemorySyncOptions) {
    this.now = options.now ?? (() => new Date());
    this.commands = new MemoryCommands(options.env);
    this.current = this.initial();
  }

  private initial(): MemoryMachineStatus {
    return {
      machine: this.options.machine.slice(0, 160) || "machine",
      phase: "off",
      message: "Memory sync is off.",
      repository: null,
      bundle: "unavailable",
      okf: { installed: false },
      conflicts: [],
    };
  }

  status(): MemoryMachineStatus {
    return this.current;
  }

  private update(change: {
    [K in keyof MemoryMachineStatus]?: MemoryMachineStatus[K] | undefined;
  }) {
    const next: Record<string, unknown> = { ...this.current, ...change };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    this.current = next as MemoryMachineStatus;
    this.options.onChange?.(this.current);
  }

  configure(value: MemoryConfiguration) {
    if (this.closed) return;
    const changed =
      value.enabled !== this.configuration.enabled ||
      value.repository !== this.configuration.repository;
    this.configuration = value;
    if (!changed) return;
    this.running?.controller.abort();
    clearInterval(this.syncTimer);
    clearInterval(this.upgradeTimer);
    this.syncTimer = this.upgradeTimer = undefined;
    if (!value.enabled) {
      this.update({
        phase: "off",
        message: "Memory sync is off.",
        repository: value.repository,
        conflicts: [],
      });
      return;
    }
    if (!value.repository) {
      this.update({
        phase: "waiting",
        message: "No memory repository is connected yet.",
        repository: null,
        conflicts: [],
      });
      void this.checkOkf();
      return;
    }
    this.update({ repository: value.repository, conflicts: [] });
    this.syncTimer = setInterval(
      () => void this.sync(),
      this.options.intervalMs ?? MEMORY_SYNC_INTERVAL_MS,
    );
    this.syncTimer.unref();
    this.upgradeTimer = setInterval(
      () => void this.upgradeOkf(),
      this.options.upgradeIntervalMs ?? OKF_UPGRADE_INTERVAL_MS,
    );
    this.upgradeTimer.unref();
    void this.sync().then(() => this.upgradeOkf());
  }

  /** Runs one sync now, or once more after the sync already in progress. */
  async sync(): Promise<MemoryMachineStatus> {
    if (this.loop) {
      this.again = true;
      await this.loop;
      return this.current;
    }
    this.loop = (async () => {
      do {
        this.again = false;
        const controller = new AbortController();
        const task = this.tick(controller.signal);
        this.running = { controller, task };
        try {
          await task;
        } finally {
          this.running = undefined;
        }
      } while (this.again && !this.closed);
    })().finally(() => {
      this.loop = undefined;
    });
    await this.loop;
    return this.current;
  }

  async close() {
    this.closed = true;
    clearInterval(this.syncTimer);
    clearInterval(this.upgradeTimer);
    this.running?.controller.abort();
    await this.loop;
  }

  private async tick(signal: AbortSignal) {
    const { enabled, repository } = this.configuration;
    if (!enabled || !repository) return;
    this.update({ phase: "syncing", message: "Syncing memory…" });
    try {
      await this.checkOkf(signal);
      const { url, branch } = await this.view(repository, signal);
      const directory = join(this.options.root, repository.split("/")[1]);
      await this.prepareClone(url, directory, signal);
      const release = await this.lock(join(directory, ".git", "scope-sync.lock"));
      try {
        await this.repair(directory, signal);
        await this.sendChanges(repository, directory, branch, signal);
      } finally {
        await release();
      }
      if (signal.aborted) return;
      const conflicts = await this.conflicts(repository, directory, branch, signal);
      await this.register(directory, signal);
      this.update({
        phase: "synced",
        message: conflicts.length
          ? `Synced. ${conflicts.length} conflict pull request${conflicts.length === 1 ? " needs" : "s need"} attention.`
          : "Synced.",
        root: directory,
        lastSyncAt: this.now().toISOString(),
        conflicts,
      });
    } catch (error) {
      if (signal.aborted) return;
      this.update({
        phase: "error",
        message:
          error instanceof SyncError
            ? error.message.slice(0, 2048)
            : `Memory sync failed: ${error instanceof Error ? error.message.slice(0, 1800) : "unknown error"}`,
      });
    }
  }

  private async view(repository: string, signal: AbortSignal) {
    const result = await this.commands.run(
      "gh",
      ["repo", "view", repository, "--json", "url,defaultBranchRef"],
      { signal },
    );
    if (result.code !== 0) {
      if (/auth login|not logged|authentication/i.test(result.stderr))
        throw new SyncError("gh is not signed in on this machine. Run gh auth login.");
      throw new SyncError(
        `gh cannot access ${repository}. Check that this machine's gh account can read and write it. ${firstLine(result.stderr)}`.trim(),
      );
    }
    const value = JSON.parse(result.stdout) as {
      url?: unknown;
      defaultBranchRef?: { name?: unknown } | null;
    };
    const url = typeof value.url === "string" ? value.url : "";
    const branch =
      typeof value.defaultBranchRef?.name === "string" ? value.defaultBranchRef.name : "";
    if (!url) throw new SyncError(`gh returned no URL for ${repository}.`);
    if (!branch)
      throw new SyncError(
        `${repository} has no commits yet. Push the initialized irudd-okf bundle, then Retry.`,
      );
    return { url, branch };
  }

  private async prepareClone(url: string, directory: string, signal: AbortSignal) {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    if (await exists(join(directory, ".git"))) {
      const origin = await this.commands.git(directory, ["remote", "get-url", "origin"], signal);
      if (origin.code !== 0 || normalizeRemote(origin.stdout) !== normalizeRemote(url))
        throw new SyncError(
          `${directory} is a clone of another repository. Move it away, then Retry.`,
        );
      return;
    }
    if ((await readdir(directory).catch(() => [])).length)
      throw new SyncError(`${directory} already has files and is not a clone. Move it away.`);
    const result = await this.commands.git(
      this.options.root,
      ["clone", "--quiet", url, directory],
      signal,
      {
        credentials: true,
      },
    );
    if (result.code !== 0)
      throw new SyncError(`Could not clone the memory repository. ${firstLine(result.stderr)}`);
  }

  private async lock(path: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.close();
        return () => unlink(path).catch(() => {});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
        if (age < STALE_LOCK_MS)
          throw new SyncError("Another Scope process is syncing this memory folder.");
        await unlink(path).catch(() => {});
      }
    }
    throw new SyncError("Another Scope process is syncing this memory folder.");
  }

  /** Clears leftovers from an interrupted sync so later syncs can run. */
  private async repair(directory: string, signal: AbortSignal) {
    const index = join(directory, ".git", "index.lock");
    const lock = await stat(index).catch(() => undefined);
    if (lock) {
      if (Date.now() - lock.mtimeMs < STALE_INDEX_LOCK_MS)
        throw new SyncError("Another git command is using the memory folder. Scope will retry.");
      await unlink(index).catch(() => {});
    }
    if (await this.rebasing(directory))
      await this.commands.git(directory, ["rebase", "--abort"], signal);
  }

  private async rebasing(directory: string) {
    return (
      (await exists(join(directory, ".git", "rebase-merge"))) ||
      (await exists(join(directory, ".git", "rebase-apply")))
    );
  }

  private async sendChanges(
    repository: string,
    directory: string,
    branch: string,
    signal: AbortSignal,
  ) {
    const head = await this.commands.git(
      directory,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    );
    if (head.stdout.trim() !== branch)
      throw new SyncError(
        `The memory folder has ${head.stdout.trim() || "a detached HEAD"} checked out. Scope syncs only ${branch}. Run git switch ${branch} in ${directory}.`,
      );
    await this.commit(directory, signal);
    const fetched = await this.commands.git(
      directory,
      ["fetch", "--quiet", "origin", branch],
      signal,
      {
        credentials: true,
      },
    );
    if (fetched.code !== 0)
      throw new SyncError(`Could not fetch memory changes. ${firstLine(fetched.stderr)}`);
    await this.commit(directory, signal);
    const upstream = `origin/${branch}`;
    if ((await this.count(directory, `HEAD..${upstream}`, signal)) > 0) {
      const ahead = await this.count(directory, `${upstream}..HEAD`, signal);
      const merged = ahead
        ? await this.commands.git(directory, ["rebase", "--quiet", upstream], signal, {
            identity: true,
          })
        : await this.commands.git(directory, ["merge", "--quiet", "--ff-only", upstream], signal);
      if (merged.code !== 0) {
        if (!ahead || !(await this.rebasing(directory)))
          throw new SyncError(`Could not update the memory folder. ${firstLine(merged.stderr)}`);
        await this.commands.git(directory, ["rebase", "--abort"], signal);
        await this.divert(repository, directory, branch, signal);
        return;
      }
    }
    if ((await this.count(directory, `${upstream}..HEAD`, signal)) === 0) return;
    const pushed = await this.commands.git(
      directory,
      ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      signal,
      { credentials: true },
    );
    if (pushed.code !== 0)
      throw new SyncError(
        `Could not push memory changes. Scope will retry. ${firstLine(pushed.stderr)}`,
      );
  }

  /** Moves this machine's conflicting commits to a pull request and resumes from the remote. */
  private async divert(repository: string, directory: string, branch: string, signal: AbortSignal) {
    await this.commit(directory, signal);
    const stamp = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
    const host = this.options.machine.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "machine";
    const name = `${MEMORY_CONFLICT_BRANCH_PREFIX}${host}-${stamp}`;
    const pushed = await this.commands.git(
      directory,
      ["push", "--quiet", "origin", `HEAD:refs/heads/${name}`],
      signal,
      { credentials: true },
    );
    if (pushed.code !== 0)
      throw new SyncError(
        `Memory changes conflict, and the conflict branch could not be pushed. Local changes are kept. ${firstLine(pushed.stderr)}`,
      );
    await this.openPullRequest(repository, name, branch, signal);
    const status = await this.commands.git(directory, ["status", "--porcelain"], signal);
    if (status.stdout.trim())
      throw new SyncError("Memory files changed during conflict handling. Scope will retry.");
    const reset = await this.commands.git(
      directory,
      ["reset", "--quiet", "--hard", `origin/${branch}`],
      signal,
    );
    if (reset.code !== 0)
      throw new SyncError(`Could not return to ${branch}. ${firstLine(reset.stderr)}`);
  }

  private openPullRequest(repository: string, head: string, base: string, signal: AbortSignal) {
    return this.commands.run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repository,
        "--head",
        head,
        "--base",
        base,
        "--title",
        `Memory conflict from ${this.options.machine.slice(0, 120)}`,
        "--body",
        `Scope could not rebase memory changes from ${this.options.machine.slice(0, 120)} onto ${base}. Merge ${base} into this branch, resolve the conflicts, then merge this pull request. Scope never merges it automatically.`,
      ],
      { signal },
    );
  }

  private async conflicts(
    repository: string,
    directory: string,
    branch: string,
    signal: AbortSignal,
  ): Promise<readonly MemoryConflict[]> {
    const listed = await this.commands.run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "url,title,headRefName,state",
      ],
      { signal },
    );
    if (listed.code !== 0) return this.current.conflicts;
    const pulls = (
      JSON.parse(listed.stdout) as {
        url: string;
        title: string;
        headRefName: string;
        state: string;
      }[]
    ).filter((pull) => pull.headRefName.startsWith(MEMORY_CONFLICT_BRANCH_PREFIX));
    const remote = await this.commands.git(
      directory,
      ["ls-remote", "--heads", "origin", `${MEMORY_CONFLICT_BRANCH_PREFIX}*`],
      signal,
      { credentials: true },
    );
    let created = false;
    if (remote.code === 0)
      for (const line of remote.stdout.split("\n")) {
        const head = line.split("\trefs/heads/")[1]?.trim();
        if (head && !pulls.some((pull) => pull.headRefName === head)) {
          const result = await this.openPullRequest(repository, head, branch, signal);
          created ||= result.code === 0;
        }
      }
    if (created) return this.conflicts(repository, directory, branch, signal);
    return pulls
      .filter((pull) => pull.state === "OPEN")
      .slice(0, 100)
      .map((pull) => ({
        url: pull.url,
        title: pull.title.slice(0, 512),
        branch: pull.headRefName,
      }));
  }

  private async register(directory: string, signal: AbortSignal) {
    if (!this.current.okf.installed) {
      this.update({
        bundle: "unavailable",
        bundleMessage: "irudd-okf is not installed on this machine. Git sync continues.",
      });
      return;
    }
    const listed = await this.commands.run("irudd-okf", ["bundle", "list"], { signal });
    const bundles =
      listed.code === 0
        ? ((JSON.parse(listed.stdout) as { bundles?: { name?: string; root?: string }[] })
            .bundles ?? [])
        : [];
    const existing = bundles.find((bundle) => bundle.name === MEMORY_BUNDLE_NAME);
    if (existing?.root && resolve(existing.root) === resolve(directory)) {
      this.update({ bundle: "registered", bundleMessage: undefined });
      return;
    }
    if (existing?.root) {
      if (!inside(this.options.root, existing.root)) {
        this.update({
          bundle: "name-taken",
          bundleMessage: `The irudd-okf bundle ${MEMORY_BUNDLE_NAME} already points to ${existing.root}. Scope leaves it unchanged.`,
        });
        return;
      }
      await this.commands.run("irudd-okf", ["bundle", "remove", MEMORY_BUNDLE_NAME], { signal });
    }
    const added = await this.commands.run(
      "irudd-okf",
      ["bundle", "add", MEMORY_BUNDLE_NAME, directory, "--activate"],
      { signal },
    );
    if (added.code === 0) {
      this.update({ bundle: "registered", bundleMessage: undefined });
      return;
    }
    const collision = /BUNDLE_COLLISION/.test(added.stdout + added.stderr);
    this.update({
      bundle: collision ? "name-taken" : "unavailable",
      bundleMessage: collision
        ? `The irudd-okf bundle name ${MEMORY_BUNDLE_NAME} is already registered. Scope leaves it unchanged.`
        : `irudd-okf could not register the bundle. ${firstLine(added.stdout || added.stderr)}`,
    });
  }

  async checkOkf(signal?: AbortSignal) {
    const result = await this.commands.run("irudd-okf", ["--version"], { signal });
    const version = /v?(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)?.[1];
    this.update({
      okf:
        result.code === 0
          ? { ...this.current.okf, installed: true, ...(version ? { version } : {}) }
          : { installed: false, message: "irudd-okf is not installed on this machine." },
    });
    return result.code === 0;
  }

  /** Upgrades an installed irudd-okf when its own check reports a newer release. */
  async upgradeOkf() {
    if (this.closed || !this.configuration.enabled || !(await this.checkOkf())) return;
    try {
      await this.performUpgrade();
    } catch {
      this.update({
        okf: {
          ...this.current.okf,
          message: "irudd-okf returned an unreadable upgrade response.",
        },
      });
    }
  }

  private async performUpgrade() {
    const okf = (message: string, version = this.current.okf.version) =>
      this.update({ okf: { installed: true, ...(version ? { version } : {}), message } });
    const check = await this.commands.run("irudd-okf", ["upgrade", "--check"]);
    if (check.code !== 0) {
      okf(
        /INVALID_ARGUMENTS|ShowHelp|Unknown|unrecognized/i.test(check.stdout + check.stderr)
          ? "This irudd-okf version is too old for automatic upgrades. Reinstall it once to enable them."
          : `Could not check for irudd-okf updates. ${firstLine(check.stdout || check.stderr)}`,
      );
      return;
    }
    const found = JSON.parse(check.stdout) as { latest?: string; updateAvailable?: boolean };
    if (!found.updateAvailable) {
      okf("irudd-okf is up to date.");
      return;
    }
    const upgraded = await this.commands.run("irudd-okf", ["upgrade"]);
    if (upgraded.code !== 0) {
      okf(
        `irudd-okf ${found.latest ?? "update"} is available, but the upgrade failed. ${firstLine(upgraded.stdout || upgraded.stderr)}`,
      );
      return;
    }
    const after = JSON.parse(upgraded.stdout) as { current?: string };
    okf(
      `Upgraded irudd-okf to ${after.current ?? found.latest ?? "the latest version"}.`,
      after.current,
    );
  }

  private async count(directory: string, range: string, signal: AbortSignal) {
    const result = await this.commands.git(directory, ["rev-list", "--count", range], signal);
    if (result.code !== 0)
      throw new SyncError(`Could not compare memory changes. ${firstLine(result.stderr)}`);
    return Number(result.stdout.trim());
  }

  private async commit(directory: string, signal: AbortSignal) {
    const added = await this.commands.git(directory, ["add", "--all"], signal);
    if (added.code !== 0)
      throw new SyncError(`Could not stage memory changes. ${firstLine(added.stderr)}`);
    const status = await this.commands.git(directory, ["status", "--porcelain"], signal);
    if (!status.stdout.trim()) return;
    const committed = await this.commands.git(
      directory,
      ["commit", "--quiet", "--no-verify", "-m", `memory: update from ${this.options.machine}`],
      signal,
      { identity: true },
    );
    if (committed.code !== 0)
      throw new SyncError(`Could not commit memory changes. ${firstLine(committed.stderr)}`);
  }
}

function firstLine(text: string) {
  return text.trim().split("\n").find(Boolean)?.slice(0, 400) ?? "";
}

function normalizeRemote(url: string) {
  return url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function inside(root: string, path: string) {
  const relation = relative(resolve(root), resolve(path));
  return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}
