import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-cli-retention-"));
  const source = join(directory, "checkout");
  const root = join(directory, "installation with spaces");
  const bin = join(directory, "bin");
  const children: ChildProcess[] = [];
  for (const path of [
    "tools/package-cli.ts",
    "apps/hub/src/installation-builds.ts",
    "packages/cli/dist",
    "apps/hub/dist",
    ".agents/skills/irudd-scope",
    ".agents/skills/irudd-scope-retro",
    "LICENSE",
    "install-cli.sh",
  ]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await cp(resolve(path), join(source, path), { recursive: true });
  }
  await exec("git", ["init", "--initial-branch=main", source]);
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", [
    "-C",
    source,
    "-c",
    "user.name=Scope test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "test: CLI payload",
  ]);
  await mkdir(bin);
  const environment = {
    ...process.env,
    SCOPE_CLI_INSTALL_ROOT: root,
    SCOPE_CLI_BIN_DIR: bin,
    SCOPE_VP: process.execPath,
    SCOPE_CLI_PREPARE: "0",
  };
  async function install(extra: NodeJS.ProcessEnv = {}) {
    await exec(process.execPath, [join(source, "tools/package-cli.ts")], {
      env: { ...environment, ...extra },
      timeout: 30_000,
    });
    return readlink(join(root, extra.SCOPE_CLI_PREPARE === "1" ? "prepared" : "current"));
  }
  async function select(name: string, build: string) {
    await rm(join(root, name), { force: true });
    await symlink(build, join(root, name));
  }
  async function running(build: string, command: "irudd-scope" | "irudd-scope-hub") {
    const main = command === "irudd-scope" ? "cli/main.mjs" : "hub/main.mjs";
    await writeFile(join(build, main), "console.log('ready'); setInterval(() => {}, 1000);\n");
    const child = spawn(join(build, "bin", command), [], { env: environment });
    children.push(child);
    await once(child.stdout!, "data");
    expect(child.exitCode).toBeNull();
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  return {
    directory,
    source,
    root,
    bin,
    install,
    select,
    running,
    stop,
    builds: async () => (await readdir(join(root, "builds"))).sort(),
    names: (...paths: string[]) =>
      paths.map((path) => path.slice(path.lastIndexOf("/") + 1)).sort(),
    async close() {
      for (const child of children) await stop(child);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("successful CLI installs retain current and previous, and leave source, user data, links and files alone", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    await mkdir(join(f.root, "source"));
    await writeFile(join(f.root, "source/keep"), "checkout");
    await mkdir(join(f.root, "user-data"));
    await writeFile(join(f.root, "user-data/keep"), "settings");
    const external = join(f.directory, "external");
    await mkdir(external);
    await writeFile(join(external, "keep"), "external");
    await symlink(external, join(f.root, "builds/external"));
    await writeFile(join(f.root, "builds/keep-file"), "file");
    const second = await f.install();
    const third = await f.install();
    expect(await f.builds()).toEqual([...f.names(second, third), "external", "keep-file"].sort());
    expect(await readlink(join(f.root, "previous"))).toBe(second);
    expect(await readlink(join(f.bin, "irudd-scope"))).toBe(
      join(f.root, "current/bin/irudd-scope"),
    );
    expect((await exec(join(f.bin, "irudd-scope"), ["--help"])).stdout).toContain(
      "irudd-scope setup",
    );
    expect(await readFile(join(f.root, "source/keep"), "utf8")).toBe("checkout");
    expect(await readFile(join(f.root, "user-data/keep"), "utf8")).toBe("settings");
    expect(await readFile(join(external, "keep"), "utf8")).toBe("external");
    await expect(readFile(join(first, "package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("preparing updates does not prune, and a later activation retains the prepared build", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    const second = await f.install();
    const prepared = await f.install({ SCOPE_CLI_PREPARE: "1" });
    const newerPrepared = await f.install({ SCOPE_CLI_PREPARE: "1" });
    expect(await readlink(join(f.root, "current"))).toBe(second);
    expect(await f.builds()).toEqual(f.names(first, second, prepared, newerPrepared));
    const third = await f.install();
    expect(await f.builds()).toEqual(f.names(second, third, newerPrepared));
    expect(await readlink(join(f.root, "prepared"))).toBe(newerPrepared);
  } finally {
    await f.close();
  }
});

test("failed CLI validation keeps existing builds and install links", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    const second = await f.install();
    const prepared = await f.install({ SCOPE_CLI_PREPARE: "1" });
    await writeFile(
      join(f.source, "packages/cli/dist/main.mjs"),
      "throw new Error('Synthetic CLI failure');\n",
    );
    await expect(f.install()).rejects.toThrow("Synthetic CLI failure");
    expect(await f.builds()).toEqual(f.names(first, second, prepared));
    expect(await readlink(join(f.root, "current"))).toBe(second);
    expect(await readlink(join(f.root, "previous"))).toBe(first);
    expect(await readlink(join(f.root, "prepared"))).toBe(prepared);
  } finally {
    await f.close();
  }
});

test("an installation that fails after activation leaves old builds available for recovery", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    const second = await f.install();
    await mkdir(join(f.directory, ".bash_profile"));
    await expect(
      f.install({ SCOPE_CLI_BIN_DIR: undefined, SHELL: "/bin/bash", HOME: f.directory }),
    ).rejects.toThrow("EISDIR");
    const activated = await readlink(join(f.root, "current"));
    expect(activated).not.toBe(second);
    expect(await readlink(join(f.root, "previous"))).toBe(second);
    expect(await f.builds()).toEqual(f.names(first, second, activated));
    expect(await readFile(join(first, "package.json"), "utf8")).toContain("scopeInstallation");
    expect(await readFile(join(second, "package.json"), "utf8")).toContain("scopeInstallation");
  } finally {
    await f.close();
  }
});

test("rollback keeps the restored CLI build and cleanup retains it through the next install", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    const second = await f.install();
    await f.select("current", first);
    await f.select("previous", second);
    expect((await exec(join(f.bin, "irudd-scope"), ["--help"])).stdout).toContain(
      "irudd-scope setup",
    );
    const third = await f.install();
    expect(await readlink(join(f.root, "previous"))).toBe(first);
    expect(await f.builds()).toEqual(f.names(first, third));
  } finally {
    await f.close();
  }
});

test("running CLI and hub processes keep older builds until they exit", async () => {
  const f = await fixture();
  try {
    const first = await f.install();
    const cli = await f.running(first, "irudd-scope");
    const second = await f.install();
    const hub = await f.running(second, "irudd-scope-hub");
    const third = await f.install();
    const fourth = await f.install();
    expect(await f.builds()).toEqual(f.names(first, second, third, fourth));
    expect(cli.exitCode).toBeNull();
    expect(hub.exitCode).toBeNull();
    await f.stop(cli);
    await f.stop(hub);
    const fifth = await f.install();
    expect(await f.builds()).toEqual(f.names(fourth, fifth));
  } finally {
    await f.close();
  }
});

test.each(["failed", "malformed", "empty"])(
  "unavailable process information preserves CLI builds: %s",
  async (failure) => {
    const f = await fixture();
    try {
      const first = await f.install();
      const second = await f.install();
      await writeFile(
        join(f.bin, "ps"),
        failure === "failed"
          ? "#!/bin/sh\nexit 1\n"
          : failure === "empty"
            ? "#!/bin/sh\nexit 0\n"
            : "#!/bin/sh\necho unreadable\n",
        { mode: 0o755 },
      );
      const third = await f.install({ PATH: `${f.bin}:${process.env.PATH}` });
      expect(await f.builds()).toEqual(f.names(first, second, third));
    } finally {
      await f.close();
    }
  },
);

test.each(["directory", "dangling"])(
  "uncertain installation links preserve CLI builds: %s",
  async (invalid) => {
    const f = await fixture();
    try {
      const first = await f.install();
      const second = await f.install();
      if (invalid === "directory") await mkdir(join(f.root, "prepared"));
      else await symlink(join(f.root, "builds/missing"), join(f.root, "prepared"));
      const third = await f.install();
      expect(await f.builds()).toEqual(f.names(first, second, third));
    } finally {
      await f.close();
    }
  },
);
