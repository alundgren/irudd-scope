import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const output = args[0];
const installRoot = process.env.SCOPE_INSTALL_ROOT;
const vp = process.env.SCOPE_VP;
if (process.platform !== "darwin" || !output || !installRoot || !vp || !isAbsolute(vp)) {
  throw new Error(
    "Package on macOS with an output directory, SCOPE_INSTALL_ROOT, and an absolute SCOPE_VP path.",
  );
}
const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const temporary = await mkdtemp(join(tmpdir(), "scope-package-"));
try {
  const source = join(temporary, "source");
  await mkdir(source);
  const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "irudd-scope",
      productName: "Scope",
      version: manifest.version,
      type: "module",
      main: "dist/main.mjs",
      scopeInstallation: { root: resolve(installRoot), vp, commit },
    }),
  );
  await cp(join(desktop, "dist"), join(source, "dist"), { recursive: true });
  await cp(join(desktop, "resources"), join(source, "resources"), { recursive: true });
  await cp(join(root, "packages/cli/dist"), join(source, "cli"), { recursive: true });
  await cp(join(root, "install.sh"), join(source, "install.sh"));
  await cp(join(root, "LICENSE"), join(source, "LICENSE"));
  await mkdir(join(source, "bin"));
  await cp(join(root, "tools/irudd-scope.sh"), join(source, "bin/irudd-scope"));
  const keyring = createRequire(require.resolve("@napi-rs/keyring"));
  for (const name of ["@napi-rs/keyring", `@napi-rs/keyring-darwin-${process.arch}`]) {
    const directory = dirname(keyring.resolve(`${name}/package.json`));
    await cp(directory, join(source, "node_modules", name), { recursive: true, dereference: true });
  }
  const [directory] = await packager({
    dir: source,
    out: join(temporary, "output"),
    name: "Scope",
    appBundleId: "alundgren.irudd-scope",
    appCategoryType: "public.app-category.developer-tools",
    icon: join(desktop, "resources/icon.icns"),
    platform: "darwin",
    arch: process.arch as "arm64" | "x64",
    electronVersion: require("electron/package.json").version,
    prune: false,
    asar: false,
    osxSign: {
      identity: "-",
      identityValidation: false,
      continueOnError: false,
      // Local builds have no Apple team identity for hardened library validation.
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
    },
  });
  const bundle = join(directory, "Scope.app");
  const executable = join(bundle, "Contents/MacOS/Scope");
  const runtimeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  await exec(executable, [join(bundle, "Contents/Resources/app/cli/main.mjs"), "--help"], {
    env: runtimeEnvironment,
    timeout: 30_000,
  });
  await exec(
    executable,
    [
      "-e",
      'require("@napi-rs/keyring"); new (require("node:sqlite").DatabaseSync)(":memory:").close()',
    ],
    {
      cwd: join(bundle, "Contents/Resources/app"),
      env: runtimeEnvironment,
      timeout: 30_000,
    },
  );
  await mkdir(resolve(output), { recursive: true });
  await rename(bundle, resolve(output, "Scope.app")).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error;
    await cp(bundle, resolve(output, "Scope.app"), { recursive: true });
  });
  console.log(`Packaged Scope at ${resolve(output, "Scope.app")}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
