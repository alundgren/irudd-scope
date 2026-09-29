import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const source = resolve(import.meta.dirname, "..");
const root = process.env.SCOPE_CLI_INSTALL_ROOT ?? join(homedir(), ".local/share/irudd-scope-cli");
const bin = process.env.SCOPE_CLI_BIN_DIR ?? join(homedir(), ".local/bin");
if (!isAbsolute(root) || !isAbsolute(bin))
  throw new Error("CLI installation paths must be absolute.");
const command = join(bin, "irudd-scope");
const target = join(root, "current/bin/irudd-scope");
const existing = await readlink(command).catch(async (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return undefined;
  throw new Error(`${command} already exists and is not managed by this installer.`);
});
if (existing !== undefined && existing !== target)
  throw new Error(`${command} belongs to another installation. Move it aside before installing.`);
const build = join(root, "builds", randomUUID());
const exec = promisify(execFile);
const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
const vp = process.env.SCOPE_VP;
if (!/^[0-9a-f]{40}$/.test(commit) || !vp || !isAbsolute(vp))
  throw new Error("The CLI build needs a Git commit and an absolute Vite+ path.");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await mkdir(build, { recursive: true });
try {
  await cp(join(source, "packages/cli/dist"), join(build, "cli"), { recursive: true });
  await cp(join(source, "apps/hub/dist"), join(build, "hub"), { recursive: true });
  await cp(join(source, ".agents/skills/irudd-scope"), join(build, "skill"), { recursive: true });
  await mkdir(join(build, "runtime"));
  await cp(process.execPath, join(build, "runtime/node"));
  await chmod(join(build, "runtime/node"), 0o755);
  await cp(join(source, "LICENSE"), join(build, "LICENSE"));
  await cp(join(source, "install-cli.sh"), join(build, "install-cli.sh"));
  await writeFile(
    join(build, "package.json"),
    JSON.stringify({ type: "module", scopeInstallation: { root, commit, vp, bin } }),
  );
  await mkdir(join(build, "bin"));
  await writeFile(
    join(build, "bin/irudd-scope"),
    `#!/bin/sh\nexport SCOPE_CLI_ROOT=${quote(join(root, "current"))}\nexec ${quote(join(build, "runtime/node"))} ${quote(join(build, "cli/main.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(build, "bin/irudd-scope-hub"),
    `#!/bin/sh\nexec ${quote(join(build, "runtime/node"))} ${quote(join(build, "hub/main.mjs"))} run\n`,
    { mode: 0o755 },
  );
  await exec(join(build, "runtime/node"), [join(build, "cli/main.mjs"), "--help"], {
    timeout: 30_000,
  });
  if (process.env.SCOPE_CLI_PREPARE === "1") {
    const next = join(root, `.prepared-${randomUUID()}`);
    await symlink(build, next);
    await rename(next, join(root, "prepared"));
    console.log(`Prepared ${build}`);
    process.exit(0);
  }
  const current = join(root, "current");
  const old = await readlink(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (old) {
    const previous = join(root, `.previous-${randomUUID()}`);
    await symlink(old, previous);
    await rename(previous, join(root, "previous"));
  }
  const next = join(root, `.current-${randomUUID()}`);
  await symlink(build, next);
  await rename(next, current);
  await mkdir(bin, { recursive: true });
  if (existing === undefined) await symlink(target, command);
  if (!process.env.SCOPE_CLI_BIN_DIR) {
    const entry = '\n# Scope CLI\nexport PATH="$HOME/.local/bin:$PATH"\n';
    const shell = process.env.SHELL ?? "/bin/bash";
    const profiles = shell.endsWith("/zsh")
      ? [".zprofile"]
      : shell.endsWith("/bash")
        ? [".bash_profile", ".bash_login", ".profile"]
        : [];
    if (profiles.length) {
      let profile = join(homedir(), profiles.at(-1)!);
      for (const candidate of profiles) {
        if (
          await access(join(homedir(), candidate)).then(
            () => true,
            () => false,
          )
        ) {
          profile = join(homedir(), candidate);
          break;
        }
      }
      const contents = await readFile(profile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      if (!contents.includes(entry)) await writeFile(profile, contents + entry);
    }
  }
  console.log(
    `Installed ${command}\nOpen a new login shell, then run irudd-scope setup on the remote.`,
  );
} catch (error) {
  // A selected build can already be in use if updating a shell profile failed.
  if ((await readlink(join(root, "current")).catch(() => undefined)) !== build)
    await rm(build, { recursive: true, force: true });
  throw error;
}
