import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AgentTools } from "../apps/desktop/src/agent-tools.ts";
import { AppUpdates } from "../apps/desktop/src/updates.ts";
import {
  activateBuild,
  pointToBuild,
  pruneBuilds,
  type Installation,
} from "../apps/desktop/src/installation-files.ts";
import { runInstallationCommand } from "../apps/desktop/src/installation-process.ts";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope installation-"));
  const root = join(directory, "install");
  const home = join(directory, "home");
  const remote = join(directory, "remote");
  await mkdir(root);
  await mkdir(home);
  await mkdir(remote);
  await exec("git", ["init", "--initial-branch=main", remote]);
  let revision = 0;
  const commit = async () => {
    await writeFile(join(remote, "README.md"), `Synthetic version ${++revision}`);
    await exec("git", ["add", "."], { cwd: remote });
    await exec(
      "git",
      [
        "-c",
        "user.name=Scope tests",
        "-c",
        "user.email=scope@example.invalid",
        "commit",
        "-m",
        "Synthetic update",
      ],
      { cwd: remote },
    );
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: remote })).stdout.trim();
  };
  const initial = await commit();
  await exec("git", ["clone", remote, join(root, "source")]);
  const vp = join(directory, "vp");
  const installation: Installation = { root, vp, commit: initial };
  async function bundle(sha: string) {
    const build = join(root, "builds", sha);
    const app = join(build, "Scope.app/Contents/Resources/app");
    const executable = join(build, "Scope.app/Contents/MacOS/Scope");
    await mkdir(join(app, "bin"), { recursive: true });
    await mkdir(join(app, "cli"));
    await mkdir(join(build, "Scope.app/Contents/MacOS"));
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({ scopeInstallation: { ...installation, commit: sha } }),
    );
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, {
      mode: 0o755,
    });
    await writeFile(
      join(app, "cli/main.mjs"),
      `console.log(${JSON.stringify(sha)}, ...process.argv.slice(2));`,
    );
    await cp(resolve("tools/irudd-scope.sh"), join(app, "bin/irudd-scope"));
    return build;
  }
  const first = await bundle(initial);
  await activateBuild(root, first);
  return { directory, root, home, remote, vp, initial, first, installation, commit, bundle };
}

test("the installed CLI follows app updates, preserves arguments, and refuses to overwrite another command", async () => {
  const f = await fixture();
  const tools = new AgentTools(f.installation, f.home, () => {});
  try {
    const installed = await tools.installCli();
    expect(installed.error).toBeUndefined();
    expect(installed.cliInstalled).toBe(true);
    const args = ["text", "Spaces, $dollars and `backticks`"];
    expect((await exec(installed.cliPath, args)).stdout.trim()).toBe(
      `${f.initial} ${args.join(" ")}`,
    );
    const next = await f.commit();
    await activateBuild(f.root, await f.bundle(next));
    expect((await exec(installed.cliPath, args)).stdout.trim()).toBe(`${next} ${args.join(" ")}`);
    await tools.removeCli();
    await writeFile(installed.cliPath, "another command");
    expect((await tools.installCli()).error).toContain("already exists");
    expect(await readFile(installed.cliPath, "utf8")).toBe("another command");
  } finally {
    await tools.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("the skill button runs npx for only Scope globally and reports failures without claiming success", async () => {
  const f = await fixture();
  const tools = new AgentTools(f.installation, f.home, () => {});
  try {
    const log = join(f.directory, "arguments.json");
    const skill = join(f.home, ".agents/skills/irudd-scope");
    await writeFile(
      f.vp,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
if (fs.existsSync(${JSON.stringify(join(f.directory, "fail"))})) { console.error('Registry unavailable'); process.exit(1); }
if (args.includes('add')) { fs.mkdirSync(${JSON.stringify(skill)}, {recursive:true}); fs.writeFileSync(${JSON.stringify(join(skill, "SKILL.md"))}, 'Synthetic skill'); }
else fs.rmSync(${JSON.stringify(skill)}, {recursive:true, force:true});
`,
      { mode: 0o755 },
    );
    expect((await tools.installSkill()).skillInstalled).toBe(true);
    expect(JSON.parse(await readFile(log, "utf8"))).toEqual([
      "exec",
      "npx",
      "--prefix",
      f.root,
      "--yes",
      "skills@1.7.0",
      "add",
      "alundgren/irudd-scope",
      "--skill",
      "irudd-scope",
      "--global",
      "--agent",
      "codex",
      "claude-code",
      "--yes",
    ]);
    expect((await tools.removeSkill()).skillInstalled).toBe(false);
    await writeFile(join(f.directory, "fail"), "");
    const failed = await tools.installSkill();
    expect(failed.error).toContain("Registry unavailable");
    expect(failed.message).toBe("");
    expect(failed.skillInstalled).toBe(false);
  } finally {
    await tools.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("startup checks skip unchanged main, preserve the running app on build failure, and activate a prepared retry", async () => {
  const f = await fixture();
  const installer = join(f.directory, "prepare.sh");
  const phases: string[] = [];
  const updates = new AppUpdates(f.installation, installer, (value) => phases.push(value.phase));
  try {
    await updates.check();
    expect(updates.snapshot().message).toBe("Scope is up to date.");
    const next = await f.commit();
    await writeFile(installer, "echo 'Synthetic build failure' >&2\nexit 1\n");
    await updates.check();
    expect(updates.snapshot().phase).toBe("error");
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    const second = await f.bundle(next);
    await pointToBuild(f.root, "prepared", second);
    await writeFile(installer, "printf 'Building locally\\n'\n");
    await Promise.all([updates.check(), updates.check()]);
    expect(updates.snapshot()).toMatchObject({ phase: "ready", nextCommit: next });
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    expect(await updates.activate()).toBe(join(second, "Scope.app/Contents/MacOS/Scope"));
    expect(await readlink(join(f.root, "current"))).toBe(second);
    expect(await readlink(join(f.root, "previous"))).toBe(f.first);
    expect(phases).toContain("checking");
    expect(phases).toContain("building");
  } finally {
    await updates.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an unavailable Git remote and cancellation leave the current app usable", async () => {
  const f = await fixture();
  const installer = join(f.directory, "prepare.sh");
  const updates = new AppUpdates(f.installation, installer, () => {});
  try {
    await exec("git", ["remote", "set-url", "origin", join(f.directory, "missing")], {
      cwd: join(f.root, "source"),
    });
    await updates.check();
    expect(updates.snapshot().phase).toBe("error");
    await exec("git", ["remote", "set-url", "origin", f.remote], { cwd: join(f.root, "source") });
    await f.commit();
    await writeFile(installer, "sleep 30\n");
    const checking = updates.check();
    await expect.poll(() => updates.snapshot().phase).toBe("building");
    await updates.cancel();
    await checking;
    expect(updates.snapshot().message).toContain("canceled");
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
  } finally {
    await updates.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("old build cleanup keeps the running, previous and prepared apps", async () => {
  const f = await fixture();
  try {
    const second = await f.bundle(await f.commit());
    await activateBuild(f.root, second);
    const third = await f.bundle(await f.commit());
    await pointToBuild(f.root, "prepared", third);
    const unused = await f.bundle(await f.commit());
    await pruneBuilds(f.installation);
    for (const build of [f.first, second, third])
      expect(
        await readFile(join(build, "Scope.app/Contents/Resources/app/package.json"), "utf8"),
      ).toContain("scopeInstallation");
    await expect(
      readFile(join(unused, "Scope.app/Contents/Resources/app/package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("canceling an installation stops child processes as well as the shell", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-cancel-"));
  const controller = new AbortController();
  try {
    const pid = join(directory, "pid");
    const running = runInstallationCommand(
      "/bin/bash",
      ["-c", `sleep 30 & echo $! > ${quote(pid)}; wait`],
      { cwd: directory, signal: controller.signal },
    );
    const failed = expect(running).rejects.toThrow("canceled");
    await expect.poll(() => readFile(pid, "utf8").catch(() => "")).not.toBe("");
    const child = Number(await readFile(pid, "utf8"));
    controller.abort();
    await failed;
    await expect
      .poll(() => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bash installer installs once, stages updates separately, and preserves edited source and the active app on failure", async () => {
  const f = await fixture();
  try {
    await rm(join(f.root, "current"));
    await rm(join(f.root, "builds"), { recursive: true });
    const bin = join(f.directory, "commands");
    await mkdir(bin);
    const git = (await exec("which", ["git"])).stdout.trim();
    const repository = "https://github.com/alundgren/irudd-scope.git";
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('get-url')) console.log(${JSON.stringify(repository)});
else { try { execFileSync(${JSON.stringify(git)}, args.map(arg => arg === ${JSON.stringify(repository)} ? ${JSON.stringify(f.remote)} : arg), {stdio:'inherit'}); } catch (e) {process.exit(e.status || 1);} }
`,
      { mode: 0o755 },
    );
    await writeFile(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
    await writeFile(join(bin, "xcode-select"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const opened = join(f.directory, "opened");
    await writeFile(
      join(bin, "open"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)}, process.argv[2]);`,
      { mode: 0o755 },
    );
    const fail = join(f.directory, "fail-build");
    const helpers = new URL("../apps/desktop/src/installation-files.ts", import.meta.url).href;
    await writeFile(
      f.vp,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
async function main() {
  if (args[0] === 'run' && args[1] === 'build' && fs.existsSync(${JSON.stringify(fail)})) throw new Error('Synthetic build failed');
  if (args[0] === 'run' && args[1] === 'package:desktop') {
    const build = args.at(-1);
    const app = path.join(build, 'Scope.app/Contents');
    fs.mkdirSync(path.join(app, 'MacOS'), {recursive:true});
    fs.mkdirSync(path.join(app, 'Resources/app'), {recursive:true});
    fs.writeFileSync(path.join(app, 'MacOS/Scope'), '#!/bin/sh\\nexit 0\\n', {mode:0o755});
    const commit = require('node:child_process').execFileSync(${JSON.stringify(git)}, ['rev-parse','HEAD'], {encoding:'utf8'}).trim();
    fs.writeFileSync(path.join(app, 'Resources/app/package.json'), JSON.stringify({scopeInstallation:{root:process.env.SCOPE_INSTALL_ROOT, vp:process.env.SCOPE_VP, commit}}));
  }
  if (args[0] === 'exec') {
    const {pointToBuild, activateBuild} = await import(${JSON.stringify(helpers)});
    if (args[5] === 'prepare') await pointToBuild(args[3], 'prepared', args[4]);
    else await activateBuild(args[3], args[4]);
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
`,
      { mode: 0o755 },
    );
    const applications = join(f.directory, "Applications");
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SCOPE_INSTALL_ROOT: f.root,
      SCOPE_APPLICATIONS_DIR: applications,
      SCOPE_VP: f.vp,
    };
    const install = (...args: string[]) =>
      exec("/bin/bash", [resolve("install.sh"), ...args], { env });
    await install();
    expect(await readlink(join(applications, "Scope.app"))).toBe(join(f.root, "current/Scope.app"));
    expect(await readFile(opened, "utf8")).toBe(join(applications, "Scope.app"));
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    await install();
    const next = await f.commit();
    await writeFile(fail, "");
    await expect(install("--prepare", next)).rejects.toMatchObject({
      stderr: expect.stringContaining("Synthetic build failed"),
    });
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    await rm(fail);
    await install("--prepare", next);
    expect(await readlink(join(f.root, "prepared"))).toBe(join(f.root, "builds", next));
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    const edited = join(f.root, "source/README.md");
    await writeFile(edited, "Keep my local changes");
    await expect(install()).rejects.toMatchObject({
      stderr: expect.stringContaining("local edits"),
    });
    expect(await readFile(edited, "utf8")).toBe("Keep my local changes");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
