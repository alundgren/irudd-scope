import {
  access,
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
  private upgradeAgain = false;
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
    const repositoryChanged = value.repository !== this.configuration.repository;
    this.configuration = value;
    if (!changed) return;
    this.running?.controller.abort();
    this.again = this.upgradeAgain = false;
    clearInterval(this.syncTimer);
    clearInterval(this.upgradeTimer);
    this.syncTimer = this.upgradeTimer = undefined;
    if (repositoryChanged)
      this.update({
        repository: value.repository,
        root: undefined,
        lastSyncAt: undefined,
        bundle: "unavailable",
        bundleMessage: undefined,
        conflicts: [],
        phase: value.enabled ? (value.repository ? "syncing" : "waiting") : "off",
      });
    if (!value.enabled) {
      this.update({
        phase: "off",
        message: "Memory sync is off.",
        repository: value.repository,
        conflicts: [],
      });
      return;
    }
    this.upgradeTimer = setInterval(
      () => void this.upgradeOkf(),
      this.options.upgradeIntervalMs ?? OKF_UPGRADE_INTERVAL_MS,
    );
    this.upgradeTimer.unref();
    if (!value.repository) {
      this.update({
        phase: "waiting",
        message: "No memory repository is connected yet.",
        repository: null,
        conflicts: [],
      });
      void this.upgradeOkf();
      return;
    }
    this.update({ repository: value.repository, phase: "syncing", conflicts: [] });
    this.syncTimer = setInterval(
      () => void this.sync(),
      this.options.intervalMs ?? MEMORY_SYNC_INTERVAL_MS,
    );
    this.syncTimer.unref();
    this.again = this.upgradeAgain = true;
    void this.drain();
  }

  /** Runs one sync now, or once more after the sync already in progress. */
  async sync(): Promise<MemoryMachineStatus> {
    if (this.closed) return this.current;
    this.again = true;
    await this.drain();
    return this.current;
  }

  private drain(): Promise<void> {
    if (this.loop) return this.loop;
    this.loop = Promise.resolve()
      .then(async () => {
        while ((this.again || this.upgradeAgain) && !this.closed) {
          const sync = this.again;
          if (sync) this.again = false;
          else this.upgradeAgain = false;
          const controller = new AbortController();
          const task = sync ? this.tick(controller.signal) : this.runUpgrade(controller.signal);
          this.running = { controller, task };
          try {
            await task;
          } finally {
            this.running = undefined;
          }
        }
      })
      .finally(() => {
        this.loop = undefined;
      });
    return this.loop;
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
      await mkdir(this.options.root, { recursive: true, mode: 0o700 });
      const release = await this.lock(
        join(this.options.root, `.${repository.split("/")[1]}.scope-sync.lock`),
      );
      try {
        await this.prepareClone(url, directory, signal);
        const releaseWriter = await this.writerLock(directory);
        try {
          await this.repair(directory);
          try {
            await this.sendChanges(repository, directory, branch, signal);
          } finally {
            // Finish the rebase cleanup before an OKF writer can edit these files.
            await this.abortRebase(directory);
          }
        } finally {
          await releaseWriter();
        }
        if (signal.aborted) return;
        const conflicts = await this.conflicts(repository, directory, branch, signal);
        await this.register(directory, signal);
        if (signal.aborted) return;
        this.update({
          phase: "synced",
          message: conflicts.length
            ? `Synced. ${conflicts.length} conflict pull request${conflicts.length === 1 ? " needs" : "s need"} attention.`
            : "Synced.",
          root: directory,
          lastSyncAt: this.now().toISOString(),
          conflicts,
        });
      } finally {
        await release();
      }
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
    } else {
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
    if (!(await exists(join(directory, "index.md"))))
      throw new SyncError(
        "The memory repository has no index.md at its root. Initialize an irudd-okf bundle before connecting it.",
      );
    const exclusions = join(directory, ".git", "info", "exclude");
    const saved = await readFile(exclusions, "utf8").catch(() => "");
    const patterns = ["/.irudd-okf/", ".okf-*.tmp"].filter(
      (pattern) => !saved.split("\n").includes(pattern),
    );
    if (patterns.length) await appendFile(exclusions, `\n${patterns.join("\n")}\n`);
  }

  private async writerLock(directory: string) {
    const folder = join(directory, ".irudd-okf");
    await mkdir(folder, { recursive: true });
    if ((await lstat(folder)).isSymbolicLink())
      throw new SyncError("The memory repository's .irudd-okf folder must not be a symbolic link.");
    const path = join(folder, "write.lock");
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf8")
        .then((raw) => {
          try {
            return JSON.parse(raw) as { scope?: unknown; pid?: unknown };
          } catch {
            return undefined;
          }
        })
        .catch(() => undefined);
      if (owner?.scope === true && typeof owner.pid === "number" && !processAlive(owner.pid)) {
        await unlink(path);
        handle = await open(path, "wx", 0o600);
      } else {
        throw new SyncError(
          "irudd-okf is writing memory, or a previous write left .irudd-okf/write.lock behind. Scope will retry. Inspect that lock if the writer stopped.",
        );
      }
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), scope: true }),
      );
    } catch (error) {
      await handle.close();
      await unlink(path);
      throw error;
    }
    return async () => {
      await handle.close();
      await unlink(path);
    };
  }

  private async lock(path: string) {
    const temporary = await mkdtemp(`${path}-`);
    const owner = `${process.pid}-${crypto.randomUUID()}`;
    await writeFile(join(temporary, owner), "", { mode: 0o600 });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Rename publishes a nonempty directory, so a competing owner cannot replace it.
          await rename(temporary, path);
          return async () => {
            await unlink(join(path, owner)).catch(() => {});
            await rmdir(path).catch(() => {});
          };
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
          const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs;
          const owners = await readdir(path).catch(() => []);
          if (
            age < STALE_LOCK_MS ||
            owners.some((entry) => processAlive(Number(entry.split("-")[0])))
          )
            throw new SyncError("Another Scope process is syncing this memory folder.");
          for (const entry of owners) await unlink(join(path, entry)).catch(() => {});
          await rmdir(path).catch(() => {});
        }
      }
      throw new SyncError("Another Scope process is syncing this memory folder.");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Clears leftovers from an interrupted sync so later syncs can run. */
  private async repair(directory: string) {
    const index = join(directory, ".git", "index.lock");
    const lock = await stat(index).catch(() => undefined);
    if (lock) {
      if (Date.now() - lock.mtimeMs < STALE_INDEX_LOCK_MS)
        throw new SyncError("Another git command is using the memory folder. Scope will retry.");
      await unlink(index).catch(() => {});
    }
    if (await this.rebasing(directory))
      throw new SyncError(
        `The memory folder has an unfinished rebase. Preserve any newer edits, then run git rebase --abort in ${directory} and Sync now.`,
      );
  }

  private async rebasing(directory: string) {
    return (
      (await exists(join(directory, ".git", "rebase-merge"))) ||
      (await exists(join(directory, ".git", "rebase-apply")))
    );
  }

  private async abortRebase(directory: string) {
    if (!(await this.rebasing(directory))) return;
    const aborted = await this.commands.git(
      directory,
      ["rebase", "--abort"],
      new AbortController().signal,
    );
    if (aborted.code !== 0)
      throw new SyncError(`Could not stop the memory rebase safely. ${firstLine(aborted.stderr)}`);
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
        await this.abortRebase(directory);
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
      ["reset", "--quiet", "--keep", `origin/${branch}`],
      signal,
    );
    if (reset.code !== 0)
      throw new SyncError(
        `Memory files changed during conflict handling. Local edits are kept. Scope will retry. ${firstLine(reset.stderr)}`,
      );
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
    const pulls: MemoryConflict[] = [];
    const remote = await this.commands.git(
      directory,
      ["ls-remote", "--heads", "origin", `${MEMORY_CONFLICT_BRANCH_PREFIX}*`],
      signal,
      { credentials: true },
    );
    if (remote.code !== 0)
      throw new SyncError(`Could not check memory conflict branches. ${firstLine(remote.stderr)}`);
    for (const line of remote.stdout.split("\n")) {
      const head = line.split("\trefs/heads/")[1]?.trim();
      if (!head) continue;
      // Query this branch across all states so an old closed PR never gets reopened.
      const listed = await this.commands.run(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          head,
          "--state",
          "all",
          "--limit",
          "1",
          "--json",
          "url,title,headRefName,state",
        ],
        { signal },
      );
      if (listed.code !== 0)
        throw new SyncError(
          `Could not check memory conflict pull requests. ${firstLine(listed.stderr)}`,
        );
      const entries = JSON.parse(listed.stdout) as { url: string; title: string; state: string }[];
      if (!Array.isArray(entries))
        throw new SyncError("gh returned unreadable memory conflict pull requests.");
      const pull = entries[0];
      if (!pull) {
        const created = await this.openPullRequest(repository, head, branch, signal);
        if (created.code !== 0)
          throw new SyncError(
            `Memory changes are saved on ${head}, but its pull request could not be opened. Scope will retry. ${firstLine(created.stderr)}`,
          );
        pulls.push({
          url: created.stdout.trim(),
          title: `Memory conflict on ${head}`,
          branch: head,
        });
      } else if (
        pull.state === "OPEN" &&
        typeof pull.url === "string" &&
        typeof pull.title === "string"
      ) {
        pulls.push({ url: pull.url, title: pull.title.slice(0, 512), branch: head });
      }
    }
    return pulls.slice(0, 100);
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
    if (signal?.aborted) return this.current.okf.installed;
    const version = /v?(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)?.[1]?.slice(0, 64);
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
    if (this.closed || !this.configuration.enabled) return;
    this.upgradeAgain = true;
    await this.drain();
  }

  private async runUpgrade(signal: AbortSignal) {
    if (!this.configuration.enabled || !(await this.checkOkf(signal)) || signal.aborted) return;
    try {
      await this.performUpgrade(signal);
    } catch {
      if (signal.aborted) return;
      this.update({
        okf: {
          ...this.current.okf,
          message: "irudd-okf returned an unreadable upgrade response.",
        },
      });
    }
  }

  private async performUpgrade(signal: AbortSignal) {
    const okf = (message: string, version = this.current.okf.version) =>
      this.update({ okf: { installed: true, ...(version ? { version } : {}), message } });
    const check = await this.commands.run("irudd-okf", ["upgrade", "--check"], { signal });
    if (signal.aborted) return;
    if (check.code !== 0) {
      okf(
        /INVALID_ARGUMENTS|ShowHelp|Unknown|unrecognized/i.test(check.stdout + check.stderr)
          ? "This irudd-okf version is too old for automatic upgrades. Reinstall it once to enable them."
          : `Could not check for irudd-okf updates. ${firstLine(check.stdout || check.stderr)}`,
      );
      return;
    }
    const found = JSON.parse(check.stdout) as { latest?: unknown; updateAvailable?: unknown };
    if (typeof found.updateAvailable !== "boolean" || typeof found.latest !== "string")
      throw new Error("Invalid irudd-okf upgrade check.");
    const latest = found.latest.slice(0, 64);
    if (!found.updateAvailable) {
      okf("irudd-okf is up to date.");
      return;
    }
    const upgraded = await this.commands.run("irudd-okf", ["upgrade"], { signal });
    if (signal.aborted) return;
    if (upgraded.code !== 0) {
      okf(
        `irudd-okf ${latest} is available, but the upgrade failed. ${firstLine(upgraded.stdout || upgraded.stderr)}`,
      );
      return;
    }
    const after = JSON.parse(upgraded.stdout) as { current?: unknown };
    if (typeof after.current !== "string") throw new Error("Invalid irudd-okf upgrade result.");
    const version = after.current.slice(0, 64);
    okf(`Upgraded irudd-okf to ${version}.`, version);
  }

  private async count(directory: string, range: string, signal: AbortSignal) {
    const result = await this.commands.git(directory, ["rev-list", "--count", range], signal);
    if (result.code !== 0)
      throw new SyncError(`Could not compare memory changes. ${firstLine(result.stderr)}`);
    return Number(result.stdout.trim());
  }

  private async commit(directory: string, signal: AbortSignal) {
    const added = await this.commands.git(
      directory,
      [
        "add",
        "--all",
        "--",
        ".",
        ":(exclude,glob)**/.irudd-okf/**",
        ":(exclude,glob)**/.okf-*.tmp",
      ],
      signal,
    );
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

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
