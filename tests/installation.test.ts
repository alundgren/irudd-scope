import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AgentTools } from "../apps/desktop/src/agent-tools.ts";
import { AppUpdates } from "../apps/desktop/src/updates.ts";
import {
  activateBuild,
  installationBuildDirectory,
  pointToBuild,
  pruneBuilds,
  readInstallation,
  type Installation,
} from "../apps/desktop/src/installation-files.ts";
import { runInstallationCommand } from "../apps/desktop/src/installation-process.ts";
import { selectSigningCertificate } from "../apps/desktop/src/signing.ts";

const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(signingIdentity?: string) {
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
  const installation: Installation = {
    root,
    vp,
    commit: initial,
    ...(signingIdentity ? { signingIdentity } : {}),
  };
  const application = join(home, "Applications/Scope.app");
  async function bundle(sha: string, signer = signingIdentity) {
    const metadata = { ...installation, commit: sha, signingIdentity: signer };
    const build = installationBuildDirectory(metadata);
    const app = join(build, "Scope.app/Contents/Resources/app");
    const executable = join(build, "Scope.app/Contents/MacOS/Scope");
    await mkdir(join(app, "bin"), { recursive: true });
    await mkdir(join(app, "cli"));
    for (const name of ["irudd-scope", "irudd-scope-retro"]) {
      const skill = join(app, "skills", name);
      await mkdir(join(skill, "references"), { recursive: true });
      await writeFile(join(skill, "SKILL.md"), `${name} ${sha}`);
      await writeFile(join(skill, "references/guide.md"), `Guide ${sha}`);
    }
    await mkdir(join(build, "Scope.app/Contents/MacOS"));
    await writeFile(join(app, "package.json"), JSON.stringify({ scopeInstallation: metadata }));
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, {
      mode: 0o755,
    });
    await writeFile(
      join(app, "cli/main.mjs"),
      `console.log(${JSON.stringify(sha)}, ...process.argv.slice(2));`,
    );
    await cp(resolve("tools/irudd-scope.sh"), join(app, "bin/irudd-scope"));
    await symlink("cli/main.mjs", join(app, "linked-cli.mjs"));
    return build;
  }
  const first = await bundle(initial);
  await activateBuild(root, first, application);
  return {
    directory,
    root,
    home,
    remote,
    vp,
    initial,
    first,
    installation,
    application,
    commit,
    bundle,
  };
}

async function installedCommit(application: string) {
  return (await readInstallation(join(application, "Contents/Resources/app"))).commit;
}

test("activation installs a complete app, remembers its location, and supports rollback", async () => {
  const f = await fixture();
  try {
    expect((await lstat(f.application)).isDirectory()).toBe(true);
    expect(await installedCommit(f.application)).toBe(f.initial);
    expect(await readlink(join(f.application, "Contents/Resources/app/linked-cli.mjs"))).toBe(
      "cli/main.mjs",
    );
    const next = await f.commit();
    const second = await f.bundle(next);
    await activateBuild(f.root, second);
    expect(await installedCommit(f.application)).toBe(next);
    expect(await readlink(join(f.root, "previous"))).toBe(f.first);
    expect(await installedCommit(join(f.first, "Scope.app"))).toBe(f.initial);
    await activateBuild(f.root, await readlink(join(f.root, "previous")));
    expect(await installedCommit(f.application)).toBe(f.initial);
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    expect(await readlink(join(f.root, "previous"))).toBe(second);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.each(["directory", "symlink"])(
  "a failed bundle copy preserves the installed %s and active build",
  async (kind) => {
    const f = await fixture();
    try {
      if (kind === "symlink") {
        await rm(f.application, { recursive: true });
        await symlink(join(f.root, "current/Scope.app"), f.application);
      }
      const second = await f.bundle(await f.commit());
      await exec("mkfifo", [join(second, "Scope.app/uncopyable")]);
      await expect(activateBuild(f.root, second)).rejects.toThrow();
      expect(await installedCommit(f.application)).toBe(f.initial);
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
      expect((await lstat(f.application)).isSymbolicLink()).toBe(kind === "symlink");
      await rm(join(second, "Scope.app/uncopyable"));
      await activateBuild(f.root, second);
      expect((await lstat(f.application)).isDirectory()).toBe(true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.each(["directory", "symlink", "other installation"])(
  "activation preserves an unrelated app %s",
  async (kind) => {
    const f = await fixture();
    try {
      await rm(f.application, { recursive: true });
      const unrelated = join(f.directory, "Unrelated.app");
      await mkdir(unrelated);
      await writeFile(join(unrelated, "keep.txt"), "Keep this app");
      if (kind === "symlink") await symlink(unrelated, f.application);
      else {
        await cp(unrelated, f.application, { recursive: true });
        if (kind === "other installation") {
          const resources = join(f.application, "Contents/Resources/app");
          await mkdir(resources, { recursive: true });
          await writeFile(
            join(resources, "package.json"),
            JSON.stringify({
              scopeInstallation: { ...f.installation, root: join(f.directory, "other") },
            }),
          );
        }
      }
      await expect(activateBuild(f.root, await f.bundle(await f.commit()))).rejects.toThrow(
        "not managed",
      );
      expect(await readFile(join(f.application, "keep.txt"), "utf8")).toBe("Keep this app");
      expect(await readlink(join(f.root, "current"))).toBe(f.first);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

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

test("Mac skills follow activation and rollback, repair partial links, and stay removed across updates", async () => {
  const f = await fixture();
  const tools = new AgentTools(f.installation, f.home, () => {});
  const shared = join(f.home, ".agents/skills/irudd-scope");
  const claude = join(f.home, ".claude/skills/irudd-scope");
  const codex = join(f.home, ".codex/skills/irudd-scope");
  try {
    await tools.syncSkills();
    await expect(lstat(shared)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await tools.installSkill()).skillInstalled).toBe(true);
    expect(await readlink(shared)).toBe(
      join(f.root, "current/Scope.app/Contents/Resources/app/skills/irudd-scope"),
    );
    await expect(lstat(codex)).rejects.toMatchObject({ code: "ENOENT" });
    const next = await f.commit();
    const second = await f.bundle(next);
    await activateBuild(f.root, second);
    expect(await readFile(join(claude, "SKILL.md"), "utf8")).toBe(`irudd-scope ${next}`);
    expect(await readFile(join(shared, "references/guide.md"), "utf8")).toBe(`Guide ${next}`);
    expect(await readFile(join(f.home, ".agents/skills/irudd-scope-retro/SKILL.md"), "utf8")).toBe(
      `irudd-scope-retro ${next}`,
    );
    await activateBuild(f.root, f.first);
    expect(await readFile(join(claude, "SKILL.md"), "utf8")).toBe(`irudd-scope ${f.initial}`);
    await rm(claude);
    expect((await tools.snapshot()).skillInstalled).toBe(false);
    expect((await tools.syncSkills()).skillInstalled).toBe(true);
    expect((await tools.removeSkill()).skillInstalled).toBe(false);
    await activateBuild(f.root, second);
    await tools.syncSkills();
    await expect(lstat(shared)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(claude)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await tools.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("startup migrates skills CLI copies, retains their files, and preserves unrelated registry entries", async () => {
  const f = await fixture();
  const tools = new AgentTools(f.installation, f.home, () => {});
  const names = ["irudd-scope", "irudd-scope-retro"];
  try {
    const skills: Record<string, unknown> = {
      unrelated: { source: "someone/other", sourceType: "github", custom: "Keep" },
    };
    for (const name of names) {
      const shared = join(f.home, ".agents/skills", name);
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "SKILL.md"), `Old ${name}`);
      await writeFile(join(shared, "custom.md"), "Preserve personal edits");
      for (const agent of [".claude", ".codex"]) {
        const path = join(f.home, agent, "skills", name);
        await mkdir(join(f.home, agent, "skills"), { recursive: true });
        await symlink(`../../.agents/skills/${name}`, path);
      }
      skills[name] = {
        source: "alundgren/irudd-scope",
        sourceType: "github",
        skillPath: `.agents/skills/${name}/SKILL.md`,
      };
    }
    const lock = join(f.home, ".agents/.skill-lock.json");
    await writeFile(lock, JSON.stringify({ version: 3, skills, custom: "Keep this too" }));
    expect((await tools.snapshot()).skillInstalled).toBe(false);
    const result = await tools.syncSkills();
    expect(result.error).toBeUndefined();
    expect(result.skillInstalled).toBe(true);
    expect(result.message).toContain("Previous copies saved");
    const registry = JSON.parse(await readFile(lock, "utf8"));
    expect(registry).toEqual({
      version: 3,
      skills: { unrelated: skills.unrelated },
      custom: "Keep this too",
    });
    const backups = await readdir(join(f.root, "skill-backups"));
    expect(backups).toHaveLength(2);
    for (const name of names) {
      const backup = backups.find((path) => path.slice(0, -37) === name)!;
      expect(await readFile(join(f.root, "skill-backups", backup, "SKILL.md"), "utf8")).toBe(
        `Old ${name}`,
      );
      expect(await readFile(join(f.root, "skill-backups", backup, "custom.md"), "utf8")).toBe(
        "Preserve personal edits",
      );
      expect(await readFile(join(f.home, ".codex/skills", name, "SKILL.md"), "utf8")).toBe(
        `${name} ${f.initial}`,
      );
    }
    await tools.syncSkills();
    expect(await readdir(join(f.root, "skill-backups"))).toEqual(backups);
    await tools.removeSkill();
    await tools.syncSkills();
    expect((await tools.snapshot()).skillInstalled).toBe(false);
  } finally {
    await tools.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.each(["directory", "symlink"])(
  "Mac skill installation leaves a separate %s and other skills unchanged",
  async (kind) => {
    const f = await fixture();
    const tools = new AgentTools(f.installation, f.home, () => {});
    const shared = join(f.home, ".agents/skills/irudd-scope");
    try {
      const other = join(f.directory, "other-skill");
      await mkdir(other);
      await writeFile(join(other, "SKILL.md"), "Keep this skill");
      await mkdir(join(f.home, ".agents/skills"), { recursive: true });
      if (kind === "directory") await cp(other, shared, { recursive: true });
      else await symlink(other, shared);
      const unrelated = join(f.home, ".agents/skills/unrelated");
      await cp(other, unrelated, { recursive: true });
      for (const action of [
        () => tools.syncSkills(),
        () => tools.installSkill(),
        () => tools.removeSkill(),
      ]) {
        const result = await action();
        expect(result.error).toContain("separate skill installation");
        expect(result.skillInstalled).toBe(false);
        expect(await readFile(join(shared, "SKILL.md"), "utf8")).toBe("Keep this skill");
        expect(await readFile(join(unrelated, "SKILL.md"), "utf8")).toBe("Keep this skill");
        await expect(lstat(join(f.home, ".claude/skills/irudd-scope"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await tools.cancel();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.getuid?.() === 0)(
  "a failed Mac skill installation restores migrated files and leaves the registry unchanged",
  async () => {
    const f = await fixture();
    const tools = new AgentTools(f.installation, f.home, () => {});
    const shared = join(f.home, ".agents/skills/irudd-scope");
    try {
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "SKILL.md"), "Old skill");
      const lock = join(f.home, ".agents/.skill-lock.json");
      const original = JSON.stringify({
        skills: {
          "irudd-scope": {
            source: "alundgren/irudd-scope",
            sourceType: "github",
            skillPath: ".agents/skills/irudd-scope/SKILL.md",
          },
        },
      });
      await writeFile(lock, original);
      await mkdir(join(f.home, ".claude/skills"), { recursive: true });
      await chmod(join(f.home, ".claude/skills"), 0o500);
      expect((await tools.syncSkills()).error).toBeDefined();
      expect((await lstat(shared)).isDirectory()).toBe(true);
      expect(await readFile(join(shared, "SKILL.md"), "utf8")).toBe("Old skill");
      expect(await readFile(lock, "utf8")).toBe(original);
    } finally {
      await chmod(join(f.home, ".claude/skills"), 0o700).catch(() => {});
      await tools.cancel();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

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
    expect(await installedCommit(f.application)).toBe(f.initial);
    expect(await updates.activate()).toBe(join(f.application, "Contents/MacOS/Scope"));
    expect((await lstat(f.application)).isDirectory()).toBe(true);
    expect(await installedCommit(f.application)).toBe(next);
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

test("updates reuse the selected signing identity and reject a change of signer", async () => {
  const signingIdentity = "A".repeat(40);
  const f = await fixture(signingIdentity);
  const installer = join(f.directory, "prepare.sh");
  const observed = join(f.directory, "signer");
  const updates = new AppUpdates(f.installation, installer, () => {});
  try {
    const next = await f.commit();
    const second = await f.bundle(next);
    await pointToBuild(f.root, "prepared", second);
    await writeFile(installer, `printf '%s' "$SCOPE_SIGNING_IDENTITY" > ${quote(observed)}\n`);
    const manifest = join(second, "Scope.app/Contents/Resources/app/package.json");
    const original = await readFile(manifest, "utf8");
    await writeFile(
      manifest,
      JSON.stringify({
        scopeInstallation: { ...f.installation, commit: next, signingIdentity: "B".repeat(40) },
      }),
    );
    await updates.check();
    expect(await readFile(observed, "utf8")).toBe(signingIdentity);
    expect(updates.snapshot()).toMatchObject({
      phase: "error",
      output: expect.stringContaining("different signing identity"),
    });
    expect(await installedCommit(f.application)).toBe(f.initial);
    await writeFile(manifest, original);
    await updates.check();
    expect(updates.snapshot().phase).toBe("ready");
    await updates.activate();
    expect(await readInstallation(join(f.application, "Contents/Resources/app"))).toMatchObject({
      commit: next,
      signingIdentity,
    });
    await pruneBuilds({ ...f.installation, commit: next });
    expect(await installedCommit(join(f.first, "Scope.app"))).toBe(f.initial);
  } finally {
    await updates.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("connecting a certificate rebuilds the current commit and keeps the current app until restart", async () => {
  const f = await fixture();
  const fingerprint = "A".repeat(40);
  const name = "Scope Local Signing";
  const installer = join(f.directory, "prepare.sh");
  const observed = join(f.directory, "signer");
  const findCertificate = async (reference: string) => {
    if (reference !== name && reference !== fingerprint) throw new Error("Certificate not found.");
    return { name, fingerprint };
  };
  const updates = new AppUpdates(f.installation, installer, () => {}, findCertificate);
  let restarted: AppUpdates | undefined;
  try {
    await updates.setSigningCertificate("Missing certificate");
    expect(updates.snapshot()).toMatchObject({ phase: "error", output: "Certificate not found." });
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    const signed = await f.bundle(f.initial, fingerprint);
    await pointToBuild(f.root, "prepared", signed);
    await writeFile(installer, `printf '%s' "$SCOPE_SIGNING_IDENTITY" > ${quote(observed)}\n`);
    await updates.setSigningCertificate(name);
    expect(await readFile(observed, "utf8")).toBe(fingerprint);
    expect(updates.snapshot()).toMatchObject({
      phase: "ready",
      operation: "signing",
      currentCommit: f.initial,
      nextCommit: f.initial,
      nextSigningCertificate: { name, fingerprint },
    });
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    await updates.cancel();
    await expect(updates.activate()).rejects.toThrow("No update is ready");
    await updates.setSigningCertificate(name);
    await updates.activate();
    const installed = await readInstallation(join(f.application, "Contents/Resources/app"));
    expect(installed).toMatchObject({ commit: f.initial, signingIdentity: fingerprint });
    restarted = new AppUpdates(installed, installer, () => {}, findCertificate);
    expect(await restarted.signingCertificate()).toEqual({ name, fingerprint });
    expect(restarted.snapshot().currentSigningIdentity).toBe(fingerprint);

    const next = await f.commit();
    await pointToBuild(f.root, "prepared", await f.bundle(next, fingerprint));
    await restarted.check();
    expect(await readFile(observed, "utf8")).toBe(fingerprint);
    expect(restarted.snapshot()).toMatchObject({ phase: "ready", nextCommit: next });
    // Disconnecting also applies to an update that is already prepared.
    const unsigned = await f.bundle(next);
    await pointToBuild(f.root, "prepared", unsigned);
    await restarted.setSigningCertificate(null);
    expect(await readFile(observed, "utf8")).toBe("-");
    await restarted.activate();
    const disconnected = await readInstallation(join(f.application, "Contents/Resources/app"));
    expect(disconnected.commit).toBe(next);
    expect(disconnected.signingIdentity).toBeUndefined();
    await pruneBuilds(disconnected);
    expect((await readdir(join(f.root, "builds"))).sort()).toEqual(
      [`${f.initial}-${fingerprint}`, next].sort(),
    );
  } finally {
    await updates.cancel();
    await restarted?.cancel();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("certificate lookup accepts self-signed identities, deduplicates fingerprints, and rejects ambiguous names", () => {
  const first = "A".repeat(40);
  const second = "B".repeat(40);
  const output = `Matching identities\n  1) ${first} "Scope Local Signing" (CSSMERR_TP_NOT_TRUSTED)\nValid identities only\n  1) ${first} "Scope Local Signing"\n`;
  expect(selectSigningCertificate(output, " Scope Local Signing ")).toEqual({
    name: "Scope Local Signing",
    fingerprint: first,
  });
  expect(selectSigningCertificate(output, first.toLowerCase()).fingerprint).toBe(first);
  expect(() => selectSigningCertificate(output, "Scope")).toThrow("No code-signing certificate");
  expect(() => selectSigningCertificate(output, " ")).toThrow("Enter the certificate name");
  const duplicate = `${output}  2) ${second} "Scope Local Signing"\n`;
  expect(() => selectSigningCertificate(duplicate, "Scope Local Signing")).toThrow("More than one");
  expect(selectSigningCertificate(duplicate, second).fingerprint).toBe(second);
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

test("repeated updates keep one previous build and remove temporary app copies", async () => {
  const f = await fixture();
  try {
    let previous = f.initial;
    for (let update = 0; update < 4; update++) {
      const next = await f.commit();
      const build = await f.bundle(next);
      await pointToBuild(f.root, "prepared", build);
      await activateBuild(f.root, build);
      const restarted = new AppUpdates({ ...f.installation, commit: next }, "unused", () => {});
      await restarted.prune();
      expect((await readdir(join(f.root, "builds"))).sort()).toEqual([previous, next].sort());
      expect(await installedCommit(f.application)).toBe(next);
      expect(await readdir(join(f.home, "Applications"))).toEqual(["Scope.app"]);
      previous = next;
    }
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
    await rm(join(f.root, "application"));
    await rm(f.application, { recursive: true });
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
    const activation = resolve("tools/activate-installation.ts");
    const signing = resolve("tools/installation-signing.ts");
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
    const signingIdentity = process.env.SCOPE_SIGNING_IDENTITY === '-' ? undefined : process.env.SCOPE_SIGNING_IDENTITY;
    fs.writeFileSync(path.join(app, 'Resources/app/package.json'), JSON.stringify({scopeInstallation:{root:process.env.SCOPE_INSTALL_ROOT, vp:process.env.SCOPE_VP, commit, signingIdentity}}));
  }
  if (args[0] === 'exec') {
    const script = args[2] === 'tools/installation-signing.ts' ? ${JSON.stringify(signing)} : ${JSON.stringify(activation)};
    require('node:child_process').execFileSync(process.execPath, [script, ...args.slice(3)], {stdio:'inherit'});
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
      SCOPE_SIGNING_IDENTITY: undefined,
    };
    const install = (...args: string[]) =>
      exec("/bin/bash", [resolve("install.sh"), ...args], { env });
    await install();
    const application = join(applications, "Scope.app");
    expect((await lstat(application)).isDirectory()).toBe(true);
    expect(await installedCommit(application)).toBe(f.initial);
    expect(await readFile(opened, "utf8")).toBe(join(applications, "Scope.app"));
    expect(await readlink(join(f.root, "current"))).toBe(f.first);
    await rm(application, { recursive: true });
    await symlink(join(f.root, "current/Scope.app"), application);
    await install();
    expect((await lstat(application)).isDirectory()).toBe(true);
    expect(await installedCommit(application)).toBe(f.initial);
    await install();
    await expect(
      exec("/bin/bash", [resolve("install.sh")], {
        env: { ...env, SCOPE_SIGNING_IDENTITY: "missing certificate name" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("certificate fingerprint") });
    expect(await installedCommit(application)).toBe(f.initial);
    const signingIdentity = "A".repeat(40);
    await exec("/bin/bash", [resolve("install.sh")], {
      env: { ...env, SCOPE_SIGNING_IDENTITY: signingIdentity.toLowerCase() },
    });
    const signedFirst = join(f.root, "builds", `${f.initial}-${signingIdentity}`);
    expect(await readlink(join(f.root, "current"))).toBe(signedFirst);
    expect(
      await readInstallation(join(f.first, "Scope.app/Contents/Resources/app")),
    ).not.toHaveProperty("signingIdentity");
    await install();
    expect(await readInstallation(join(application, "Contents/Resources/app"))).toHaveProperty(
      "signingIdentity",
      signingIdentity,
    );
    const next = await f.commit();
    await writeFile(fail, "");
    await expect(install("--prepare", next)).rejects.toMatchObject({
      stderr: expect.stringContaining("Synthetic build failed"),
    });
    expect(await readlink(join(f.root, "current"))).toBe(signedFirst);
    expect(await installedCommit(application)).toBe(f.initial);
    await rm(fail);
    await install("--prepare", next);
    expect(await readlink(join(f.root, "prepared"))).toBe(
      join(f.root, "builds", `${next}-${signingIdentity}`),
    );
    expect(await readlink(join(f.root, "current"))).toBe(signedFirst);
    expect(await installedCommit(application)).toBe(f.initial);
    await install();
    expect(await installedCommit(application)).toBe(next);
    expect(await readlink(join(f.root, "previous"))).toBe(signedFirst);
    await exec("/bin/bash", [resolve("install.sh")], {
      env: { ...env, SCOPE_SIGNING_IDENTITY: "-" },
    });
    expect(await readInstallation(join(application, "Contents/Resources/app"))).not.toHaveProperty(
      "signingIdentity",
    );
    expect(await readlink(join(f.root, "current"))).toBe(join(f.root, "builds", next));
    const edited = join(f.root, "source/README.md");
    await writeFile(edited, "Keep my local changes");
    await expect(install()).rejects.toMatchObject({
      stderr: expect.stringContaining("local edits"),
    });
    expect(await readFile(edited, "utf8")).toBe("Keep my local changes");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 180_000);
