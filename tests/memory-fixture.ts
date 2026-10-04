import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MEMORY_REPOSITORY = "octo/personal-memory";

/** A GitHub stand-in: a bare repository, synthetic gh and irudd-okf, and isolated git settings. */
export async function memoryFixture(cleanup: (() => Promise<unknown> | void)[]) {
  const directory = await mkdtemp(join(tmpdir(), "scope-memory-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const remotes = join(directory, "remotes");
  const state = join(directory, "gh-state");
  await mkdir(remotes);
  await mkdir(state);
  const bare = join(remotes, "personal-memory.git");
  const base = {
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: undefined,
    FAKE_GH_REMOTES: remotes,
    FAKE_GH_STATE: state,
  };
  const path = (bin: "bin" | "gh-only") =>
    [
      resolve("tests/fixtures/memory", bin),
      dirname(process.execPath),
      ...(process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.includes(".local")),
    ].join(delimiter);
  const env = (machine: string, options: { okf?: boolean; extra?: NodeJS.ProcessEnv } = {}) =>
    ({
      ...process.env,
      ...base,
      PATH: path(options.okf === false ? "gh-only" : "bin"),
      FAKE_OKF_CONFIG: join(directory, `${machine}-okf.json`),
      ...options.extra,
    }) as NodeJS.ProcessEnv;
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd, env: { ...process.env, ...base } as NodeJS.ProcessEnv }))
      .stdout;
  await git(remotes, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  const seed = join(directory, "seed");
  await git(directory, "clone", "--quiet", bare, seed);
  await git(seed, "config", "user.email", "operator@example.test");
  await git(seed, "config", "user.name", "Operator");
  await writeFile(join(seed, "index.md"), "# Personal memory\n\nFirst line.\n");
  await git(seed, "add", "index.md");
  await git(seed, "commit", "--quiet", "-m", "Initialize memory");
  await git(seed, "push", "--quiet", "origin", "main");
  return {
    directory,
    bare,
    env,
    git,
    root: (machine: string) => join(directory, machine, "memory"),
    clone: (machine: string) => join(directory, machine, "memory", "personal-memory"),
    head: async () => (await git(directory, "--git-dir", bare, "rev-parse", "main")).trim(),
    remoteBranches: async () =>
      (await git(directory, "--git-dir", bare, "branch", "--list", "--format=%(refname:short)"))
        .split("\n")
        .filter(Boolean),
    pulls: async () =>
      (await readFile(join(state, "prs.jsonl"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { url: string; headRefName: string; state: string }),
    okfConfig: async (machine: string) =>
      JSON.parse(
        await readFile(join(directory, `${machine}-okf.json`), "utf8").catch(
          () => '{"bundles":[]}',
        ),
      ) as { bundles: { name: string; root: string }[] },
    setOkfConfig: (machine: string, bundles: { name: string; root: string }[]) =>
      writeFile(join(directory, `${machine}-okf.json`), JSON.stringify({ bundles })),
  };
}
