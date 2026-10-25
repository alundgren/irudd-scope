import { afterEach, expect, test, vi } from "vite-plus/test";
import * as files from "node:fs/promises";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentTools } from "../apps/desktop/src/agent-tools.ts";
import { AppUpdates } from "../apps/desktop/src/updates.ts";
import {
  installationAppDirectory,
  installationBuildDirectory,
  pointToBuild,
  pruneBuilds,
  readInstallation,
  type Installation,
} from "../apps/desktop/src/installation-files.ts";
import {
  activateWindowsBuild,
  runningWindowsBuilds,
} from "../apps/desktop/src/windows-installation.ts";
import * as installationProcess from "../apps/desktop/src/installation-process.ts";
import { packageWindowsLaunchers } from "../tools/package-windows-launcher.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rm: vi.fn(original.rm) };
});

const exec = promisify(execFile);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope Windows ' & café-"));
  const root = join(directory, "install");
  const home = join(directory, "home");
  const installation: Installation = {
    root,
    vp: join(directory, "vp.exe"),
    commit: "a".repeat(40),
    platform: "win32",
  };
  await mkdir(home);
  await mkdir(join(root, "source"), { recursive: true });
  const integrate = vi.fn(async () => {});
  const bundle = async (commit: string) => {
    const metadata = { ...installation, commit };
    const build = installationBuildDirectory(metadata);
    const app = installationAppDirectory(build, "win32");
    await mkdir(join(app, "bin"), { recursive: true });
    await mkdir(join(app, "cli"));
    await writeFile(join(build, "Scope/Scope.exe"), `Immutable runtime ${commit}`);
    await writeFile(join(app, "package.json"), JSON.stringify({ scopeInstallation: metadata }));
    await writeFile(join(app, "bin/Scope.exe"), "Scope native desktop launcher v1");
    await writeFile(join(app, "bin/irudd-scope.exe"), "Scope native CLI launcher v1");
    await writeFile(
      join(app, "cli/main.mjs"),
      `console.log(JSON.stringify({commit:${JSON.stringify(commit)}, args:process.argv.slice(2)}));`,
    );
    for (const name of ["irudd-scope", "irudd-scope-retro"]) {
      await mkdir(join(app, "skills", name), { recursive: true });
      await writeFile(join(app, "skills", name, "SKILL.md"), `${name} ${commit}`);
    }
    return build;
  };
  const first = await bundle(installation.commit);
  return { directory, root, home, installation, first, bundle, integrate };
}

test(
  "Windows activation keeps immutable builds and moves desktop, CLI, and skills together",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    const paths: string[] = [];
    vi.spyOn(installationProcess, "runInstallationCommand").mockImplementation(
      async (_command, args) => {
        paths.push(args.at(-1)!);
        return "";
      },
    );
    const tools = new AgentTools(f.installation, f.home, () => {});
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      expect(
        (await readInstallation(installationAppDirectory(join(f.root, "current"), "win32"))).commit,
      ).toBe(f.installation.commit);
      expect((await tools.installCli()).cliInstalled).toBe(true);
      expect((await tools.installSkill()).skillInstalled).toBe(true);
      const launcher = await readFile(join(f.root, "Scope.exe"));
      const next = "b".repeat(40);
      const second = await f.bundle(next);
      await activateWindowsBuild(f.root, second, f.integrate);
      expect(await readFile(join(f.first, "Scope/Scope.exe"), "utf8")).toBe(
        `Immutable runtime ${f.installation.commit}`,
      );
      expect(await readFile(join(f.root, "Scope.exe"))).toEqual(launcher);
      expect(await readFile(join(f.home, ".claude/skills/irudd-scope/SKILL.md"), "utf8")).toBe(
        `irudd-scope ${next}`,
      );
      expect((await tools.snapshot()).cliInstalled).toBe(true);
      await activateWindowsBuild(f.root, f.first, f.integrate);
      expect(await readFile(join(f.home, ".agents/skills/irudd-scope/SKILL.md"), "utf8")).toBe(
        `irudd-scope ${f.installation.commit}`,
      );
      await rm(join(f.home, ".claude/skills/irudd-scope"));
      expect((await tools.syncSkills()).skillInstalled).toBe(true);
      expect((await tools.removeCli()).cliInstalled).toBe(false);
      expect((await tools.removeSkill()).skillInstalled).toBe(false);
      await activateWindowsBuild(f.root, second, f.integrate);
      expect((await tools.syncSkills()).skillInstalled).toBe(false);
      expect(paths).toEqual(["add", "remove"]);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "a failed Windows activation restores every changed reference and preserves the stable launcher",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      const second = await f.bundle("b".repeat(40));
      await activateWindowsBuild(f.root, second, f.integrate);
      const launcher = await readFile(join(f.root, "Scope.exe"));
      const third = await f.bundle("c".repeat(40));
      await expect(
        activateWindowsBuild(f.root, third, async () => {
          throw new Error("Synthetic protocol installation failure");
        }),
      ).rejects.toThrow("Synthetic protocol");
      expect(await readlink(join(f.root, "current"))).toBe(second);
      expect(await readlink(join(f.root, "previous"))).toBe(f.first);
      expect(await readFile(join(f.root, "Scope.exe"))).toEqual(launcher);
      expect(await readFile(join(second, "Scope/Scope.exe"), "utf8")).toBe(
        `Immutable runtime ${"b".repeat(40)}`,
      );
      await expect(lstat(join(f.root, ".activation-lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await activateWindowsBuild(f.root, third, f.integrate);
      await pruneBuilds({ ...f.installation, commit: "c".repeat(40) });
      await expect(lstat(f.first)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(second)).isDirectory()).toBe(true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "a failed first Windows activation removes only the references it created",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    try {
      await expect(
        activateWindowsBuild(f.root, f.first, async () => {
          throw new Error("Synthetic shortcut failure");
        }),
      ).rejects.toThrow("Synthetic shortcut");
      for (const name of ["current", "previous", "Scope.exe", ".activation-lock"])
        await expect(lstat(join(f.root, name))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(f.first)).isDirectory()).toBe(true);
      await writeFile(join(f.root, "Scope.exe"), "An unrelated application");
      await expect(activateWindowsBuild(f.root, f.first, f.integrate)).rejects.toThrow(
        "not Scope's launcher",
      );
      expect(await readFile(join(f.root, "Scope.exe"), "utf8")).toBe("An unrelated application");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows CLI repair preserves other commands and undoes a failed PATH installation",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    const tools = new AgentTools(f.installation, f.home, () => {});
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      vi.spyOn(installationProcess, "runInstallationCommand").mockRejectedValue(
        new Error("Synthetic PATH failure"),
      );
      const failed = await tools.installCli();
      expect(failed.error).toContain("PATH failure");
      expect(failed.cliInstalled).toBe(false);
      await expect(lstat(failed.cliPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(failed.cliPath, "Keep this command");
      expect((await tools.installCli()).error).toContain("already exists");
      expect((await tools.removeCli()).error).toContain("not installed by Scope");
      expect(await readFile(failed.cliPath, "utf8")).toBe("Keep this command");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows updates invoke PowerShell with literal paths and accept only the prepared build",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    const installer = join(f.directory, "install ' & café.ps1");
    const updates = new AppUpdates(f.installation, installer, () => {});
    const next = "b".repeat(40);
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      const second = await f.bundle(next);
      const calls = vi
        .spyOn(installationProcess, "runInstallationCommand")
        .mockImplementation(async (command) => {
          if (command === "git") return `${next}\trefs/heads/main`;
          await pointToBuild(f.root, "prepared", second);
          return "Build completed";
        });
      await updates.check();
      expect(updates.snapshot()).toMatchObject({ phase: "ready", nextCommit: next });
      expect(calls.mock.calls[1]![1]).toEqual([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-Prepare",
        next,
      ]);
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
      await updates.cancel();
      expect(updates.snapshot().phase).toBe("idle");
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
      calls.mockRejectedValue(new Error("Synthetic process failure"));
      await updates.check();
      expect(updates.snapshot().phase).toBe("error");
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
    } finally {
      await updates.cancel();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "native Windows CLI passes every argument unchanged and follows update and rollback",
  { tags: ["safe-updates"], timeout: 30_000 },
  async () => {
    const f = await fixture();
    let desktopPid: number | undefined;
    try {
      const app = installationAppDirectory(f.first, "win32");
      await rm(join(app, "bin/Scope.exe"));
      await rm(join(app, "bin/irudd-scope.exe"));
      await packageWindowsLaunchers(
        resolve("tools/windows-launcher.cs"),
        join(app, "bin"),
        resolve("apps/desktop/resources/icon.ico"),
      );
      await copyFile(process.execPath, join(f.first, "Scope/Scope.exe"));
      await activateWindowsBuild(f.root, f.first, f.integrate);
      const cli = join(f.root, "bin/irudd-scope.exe");
      await mkdir(dirname(cli), { recursive: true });
      await copyFile(join(app, "bin/irudd-scope.exe"), cli);
      const args = [
        "",
        "two words",
        'double"quote',
        "trailing\\",
        'slash\\"quote',
        "& echo wrong",
        "%SCOPE_TEST%",
        "café",
        "😀",
        "'$()^|<>",
      ];
      expect(JSON.parse((await exec(cli, args)).stdout)).toEqual({
        commit: f.installation.commit,
        args,
      });
      const second = await f.bundle("b".repeat(40));
      await copyFile(process.execPath, join(second, "Scope/Scope.exe"));
      await activateWindowsBuild(f.root, second, f.integrate);
      expect(JSON.parse((await exec(cli, args)).stdout)).toEqual({ commit: "b".repeat(40), args });
      await activateWindowsBuild(f.root, f.first, f.integrate);
      expect(JSON.parse((await exec(cli, args)).stdout)).toEqual({
        commit: f.installation.commit,
        args,
      });
      const ready = join(f.directory, "desktop-ready");
      const proceed = join(f.directory, "desktop-proceed");
      const observed = join(f.directory, "desktop-result");
      const code = `const fs=require('node:fs'), path=require('node:path'); fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,executable:process.execPath})); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(proceed)})){fs.writeFileSync(${JSON.stringify(observed)}, fs.readFileSync(path.join(path.dirname(process.execPath),'resources/app/package.json'))); clearInterval(timer);}},25); setTimeout(()=>process.exit(),10000).unref();`;
      const launcher = spawn(join(f.root, "Scope.exe"), ["-e", code], {
        stdio: "ignore",
        windowsHide: true,
      });
      await once(launcher, "exit");
      await expect.poll(() => readFile(ready, "utf8").catch(() => "")).not.toBe("");
      const started = JSON.parse(await readFile(ready, "utf8"));
      desktopPid = started.pid;
      expect(started.executable.toLowerCase()).toBe(join(f.first, "Scope/Scope.exe").toLowerCase());
      await activateWindowsBuild(f.root, second, f.integrate);
      const third = await f.bundle("c".repeat(40));
      await activateWindowsBuild(f.root, third, f.integrate);
      await pruneBuilds({ ...f.installation, commit: "c".repeat(40) });
      expect((await lstat(f.first)).isDirectory()).toBe(true);
      await writeFile(proceed, "");
      await expect.poll(() => readFile(observed, "utf8").catch(() => "")).not.toBe("");
      expect(JSON.parse(await readFile(observed, "utf8")).scopeInstallation.commit).toBe(
        f.installation.commit,
      );
    } finally {
      if (desktopPid) {
        try {
          process.kill(desktopPid);
        } catch {
          /* The child already exited. */
        }
        await expect
          .poll(() => {
            try {
              process.kill(desktopPid!, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
      }
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "committed Windows activation remains successful when old junction cleanup fails",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      const second = await f.bundle("b".repeat(40));
      const remove = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
        .rm;
      vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path).endsWith(".previous")) throw new Error("Synthetic cleanup failure");
        await remove(path, options);
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(activateWindowsBuild(f.root, second, f.integrate)).resolves.toBe(
        join(second, "Scope"),
      );
      expect(await readlink(join(f.root, "current"))).toBe(second);
      expect(await readlink(join(f.root, "previous"))).toBe(f.first);
    } finally {
      vi.restoreAllMocks();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows pruning retains a running build under Unicode paths with different casing",
  { tags: ["safe-updates"] },
  async () => {
    const root = "C:\\Users\\Åsa\\Scope";
    const commit = "a".repeat(40);
    vi.spyOn(installationProcess, "runInstallationCommand").mockResolvedValue(
      JSON.stringify([
        `c:\\users\\Åsa\\scope\\builds\\${commit}\\Scope\\Scope.exe`,
        `C:\\Other Scope\\builds\\${commit}\\Scope\\Scope.exe`,
      ]),
    );
    expect(await runningWindowsBuilds(root)).toEqual([`${root}\\builds\\${commit}`]);
  },
);

test(
  "canceling a build terminates its native child processes",
  { tags: ["safe-updates"] },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-process-"));
    const controller = new AbortController();
    try {
      const pidFile = join(directory, "pid");
      const code = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(()=>{},1000);`;
      const command = installationProcess.runInstallationCommand(process.execPath, ["-e", code], {
        cwd: directory,
        signal: controller.signal,
      });
      const canceled = expect(command).rejects.toThrow("canceled");
      await expect.poll(() => readFile(pidFile, "utf8").catch(() => "")).not.toBe("");
      const pid = Number(await readFile(pidFile, "utf8"));
      controller.abort();
      await canceled;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
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
  },
);

test(
  "an interrupted Windows registration restores its backup before rolling the active build back",
  { tags: ["safe-updates"] },
  async () => {
    const f = await fixture();
    try {
      await activateWindowsBuild(f.root, f.first, f.integrate);
      const registration = join(f.directory, "synthetic-registration");
      await writeFile(registration, "Previous registration");
      const next = await f.bundle("b".repeat(40));
      const calls = vi
        .spyOn(installationProcess, "runInstallationCommand")
        .mockImplementation(async (_command, args) => {
          const backup = args[args.indexOf("-Backup") + 1]!;
          const saved = join(backup, "synthetic-registration");
          if (args.at(-1) === "apply") {
            await copyFile(registration, saved);
            await writeFile(registration, "Replacement registration");
            throw new Error("The operation was canceled or timed out.");
          }
          await copyFile(saved, registration);
          return "";
        });
      await expect(activateWindowsBuild(f.root, next)).rejects.toThrow("timed out");
      expect(calls.mock.calls.map((call) => call[1].at(-1))).toEqual(["apply", "restore"]);
      expect(await readFile(registration, "utf8")).toBe("Previous registration");
      const powershell =
        process.env.SCOPE_TEST_POWERSHELL ??
        (process.platform === "win32" ? installationProcess.windowsPowerShell() : undefined);
      if (powershell) {
        const result = await exec(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("tests/windows-integration-fixture.ps1"),
          "-Integration",
          resolve("tools/windows-integration.ps1"),
          "-Directory",
          f.directory,
        ]);
        expect(result.stdout).toContain("Windows integration fixture passed:");
      }
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
      await expect(lstat(join(f.root, "previous"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);
