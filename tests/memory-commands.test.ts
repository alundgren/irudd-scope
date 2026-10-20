import { afterEach, expect, test } from "vite-plus/test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
