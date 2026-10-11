import { afterEach, expect, test } from "vite-plus/test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryCommands } from "../packages/memory-sync/src/commands.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope memory Å & "));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const executable = join(bin, process.platform === "win32" ? "scope-tool.exe" : "scope-tool");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  // Exercise the spelling inherited from a native Windows desktop launch.
  env[process.platform === "win32" ? "Path" : "PATH"] = bin;
  return { directory, bin, executable, env, commands: new MemoryCommands(env) };
}

test("memory commands find native executables and preserve spaces, Unicode and shell characters", async () => {
  const f = await fixture();
  const args = [
    "two words",
    "Ångström",
    "a&b",
    "a|b",
    'a"b',
    "100%",
    "!value!",
    "^caret",
    "",
    "C:\\folder with spaces\\",
  ];
  const result = await f.commands.run("scope-tool", [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...args,
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
  await mkdir(join(f.bin, "directory-only"));
  expect(await f.commands.resolve("directory-only")).toBeUndefined();
  expect(await f.commands.run("missing-tool", [])).toMatchObject({ code: 127 });
});

test.runIf(process.platform === "win32")(
  "memory commands launch package .cmd wrappers without interpreting arguments as commands",
  async () => {
    const f = await fixture();
    const bin = join(f.directory, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const script = join(f.directory, "arguments.cjs");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    await writeFile(
      join(bin, "scope-wrapper.cmd"),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    const commands = new MemoryCommands({ ...f.env, Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" });
    const args = [
      "two words",
      "Ångström",
      "&echo injection",
      "a|b",
      'a"b',
      "100%",
      "!value!",
      "^caret",
      "",
    ];
    const result = await commands.run("scope-wrapper", args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  },
);

test("cancelling a memory command also stops the subprocess it launched", async () => {
  const f = await fixture();
  const heartbeat = join(f.directory, "heartbeat");
  const pids = join(f.directory, "pids.json");
  const script = join(f.directory, "parent.cjs");
  await writeFile(
    script,
    `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 50);`)}], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`,
  );
  const controller = new AbortController();
  const running = f.commands.run("scope-tool", [script], { signal: controller.signal });
  cleanup.push(async () => {
    controller.abort();
    await running;
    for (const pid of JSON.parse(await readFile(pids, "utf8").catch(() => "[]"))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  });
  await expect.poll(() => readFile(heartbeat, "utf8").catch(() => "")).not.toBe("");
  controller.abort();
  expect((await running).code).not.toBe(0);
  const stopped = await readFile(heartbeat, "utf8");
  await delay(200);
  expect(await readFile(heartbeat, "utf8")).toBe(stopped);
});

test("a pre-cancelled memory command never starts a process", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  expect(
    await f.commands.run("scope-tool", ["-e", "process.stdout.write('started')"], {
      signal: controller.signal,
    }),
  ).toMatchObject({ code: 1, stdout: "" });
});
