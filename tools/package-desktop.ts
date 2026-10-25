import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { readSigningIdentity } from "../apps/desktop/src/installation-files.ts";
import { CREDENTIAL_HELPER_NAME } from "../apps/desktop/src/credential-helper.ts";
import { packageCredentialHelper } from "./package-credential-helper.ts";
import { packageWindowsLaunchers } from "./package-windows-launcher.ts";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const desktop = join(root, "apps/desktop");
const require = createRequire(join(desktop, "package.json"));
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const output = args[0];
const installRoot = process.env.SCOPE_INSTALL_ROOT;
const vp = process.env.SCOPE_VP;
const windows = process.platform === "win32";
if (
  (!windows && process.platform !== "darwin") ||
  (windows && process.arch !== "x64") ||
  !output ||
  !installRoot ||
  !vp ||
  !isAbsolute(vp)
) {
  throw new Error(
    "Package on macOS or Windows x64 with an output directory, SCOPE_INSTALL_ROOT, and an absolute SCOPE_VP path.",
  );
}
const commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
const signingIdentity = windows
  ? undefined
  : await readSigningIdentity(resolve(installRoot), process.env.SCOPE_SIGNING_IDENTITY);
const temporary = await mkdtemp(join(tmpdir(), "scope-package-"));
try {
  const helper = join(temporary, CREDENTIAL_HELPER_NAME);
  if (signingIdentity)
    await packageCredentialHelper({
      output: helper,
      identity: signingIdentity,
      reusable: join(installRoot, "current/Scope.app/Contents/Helpers", CREDENTIAL_HELPER_NAME),
    });
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
      scopeInstallation: {
        root: resolve(installRoot),
        vp,
        commit,
        signingIdentity,
        ...(windows ? { platform: "win32" } : {}),
      },
    }),
  );
  await mkdir(join(source, "dist"));
  for (const entry of [
    "main.mjs",
    "preload.cjs",
    "cli-process.mjs",
    "guest-process.mjs",
    "key-pipe.ps1",
    "folder-writer.mjs",
    "renderer",
  ])
    await cp(join(desktop, "dist", entry), join(source, "dist", entry), { recursive: true });
  await cp(join(desktop, "resources"), join(source, "resources"), { recursive: true });
  await cp(join(root, "packages/cli/dist"), join(source, "cli"), { recursive: true });
  for (const name of ["irudd-scope", "irudd-scope-retro"])
    await cp(join(root, ".agents/skills", name), join(source, "skills", name), { recursive: true });
  const installer = windows ? "install.ps1" : "install.sh";
  await cp(join(root, installer), join(source, installer));
  await cp(join(root, "LICENSE"), join(source, "LICENSE"));
  await mkdir(join(source, "bin"));
  let windowsIcon: string | undefined;
  if (windows) {
    windowsIcon = await packageWindowsLaunchers(
      join(root, "tools/windows-launcher.cs"),
      join(source, "bin"),
      join(desktop, "resources/icon.ico"),
    );
    await cp(join(root, "tools/windows-integration.ps1"), join(source, "windows-integration.ps1"));
    await cp(join(root, "tools/windows-cli-path.ps1"), join(source, "windows-cli-path.ps1"));
  } else {
    await cp(join(root, "tools/irudd-scope.sh"), join(source, "bin/irudd-scope"));
    const keyring = createRequire(require.resolve("@napi-rs/keyring"));
    for (const name of ["@napi-rs/keyring", `@napi-rs/keyring-darwin-${process.arch}`]) {
      const directory = dirname(keyring.resolve(`${name}/package.json`));
      await cp(directory, join(source, "node_modules", name), {
        recursive: true,
        dereference: true,
      });
    }
  }
  const [directory] = await packager({
    dir: source,
    out: join(temporary, "output"),
    name: "Scope",
    appBundleId: "alundgren.irudd-scope",
    appCategoryType: "public.app-category.developer-tools",
    icon: windowsIcon,
    extraResource: windows ? [] : [join(desktop, "resources/icon.icns")],
    extendInfo: {
      CFBundleIconFile: "icon.icns",
      CFBundleURLTypes: [
        {
          CFBundleURLName: "alundgren.irudd-scope.transfer",
          CFBundleURLSchemes: ["scope-transfer"],
        },
      ],
    },
    platform: windows ? "win32" : "darwin",
    arch: process.arch as "arm64" | "x64",
    electronVersion: require("electron/package.json").version,
    prune: false,
    asar: false,
    afterCopy: [
      async ({ buildPath }) => {
        if (!signingIdentity) return;
        const directory = resolve(buildPath, "../../Helpers");
        await mkdir(directory, { recursive: true });
        await cp(helper, join(directory, CREDENTIAL_HELPER_NAME));
      },
    ],
    osxSign: windows
      ? undefined
      : {
          identity: signingIdentity ?? "-",
          identityValidation: false,
          continueOnError: false,
          // Preserve the helper's CodeDirectory hash and its existing Keychain approval.
          ignore: (path) => path.endsWith(`/Contents/Helpers/${CREDENTIAL_HELPER_NAME}`),
          // A local certificate need not have an Apple team identity for library validation.
          optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
        },
  });
  const bundle = windows ? directory : join(directory, "Scope.app");
  const resources = windows
    ? join(bundle, "resources/app")
    : join(bundle, "Contents/Resources/app");
  const executable = windows ? join(bundle, "Scope.exe") : join(bundle, "Contents/MacOS/Scope");
  const runtimeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  await exec(executable, [join(resources, "cli/main.mjs"), "--help"], {
    env: runtimeEnvironment,
    windowsHide: true,
    timeout: 30_000,
  });
  await exec(
    executable,
    [
      "-e",
      `${windows ? "" : 'require("@napi-rs/keyring");'} new (require("node:sqlite").DatabaseSync)(":memory:").close()`,
    ],
    {
      cwd: resources,
      windowsHide: true,
      env: runtimeEnvironment,
      timeout: 30_000,
    },
  );
  await mkdir(resolve(output), { recursive: true });
  const packaged = resolve(output, windows ? "Scope" : "Scope.app");
  await rename(bundle, packaged).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EXDEV") throw error;
    await cp(bundle, packaged, { recursive: true });
  });
  console.log(`Packaged Scope at ${packaged}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
