import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const version = "go1.27.1";
const checksums: Record<string, string> = {
  "darwin-amd64": "8f8f52c6649542cf027bbc9b9c68d1ec042f9f34808a40413f0b8b3f66f3caa4",
  "darwin-arm64": "ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12",
  "linux-amd64": "63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445",
  "linux-arm64": "3450b45a3f9ee8568792736a5c5e70a1f2e9b36c35a8f74958c03e51d7d92bec",
};
const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;

async function pinnedGo() {
  try {
    const result = await exec("go", ["version"], { timeout: 10_000 });
    if (result.stdout.startsWith(`go version ${version} `)) return "go";
  } catch {
    // Builds provision the pinned compiler when the host has no matching Go install.
  }
  if (!checksums[platform])
    throw new Error("Scope transfer builds require Linux or macOS on x64 or arm64.");
  const cache = join(homedir(), ".cache/irudd-scope/build");
  const installed = join(cache, `${version}-${platform}`);
  const executable = join(installed, "go/bin/go");
  try {
    if ((await exec(executable, ["version"])).stdout.startsWith(`go version ${version} `)) {
      return executable;
    }
  } catch {
    // Only a complete compiler is published to the shared cache.
  }
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, "go-download-"));
  try {
    const response = await fetch(`https://go.dev/dl/${version}.${platform}.tar.gz`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error("Could not download the Scope transfer build compiler.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== checksums[platform]) {
      throw new Error("The Scope transfer build compiler failed checksum verification.");
    }
    const archive = join(temporary, "go.tar.gz");
    await writeFile(archive, bytes);
    await exec("tar", ["-xzf", archive, "-C", temporary], { timeout: 60_000 });
    await rm(archive);
    try {
      await rename(temporary, installed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      // A simultaneous build can publish first; never remove its compiler.
      const winner = await exec(executable, ["version"], { timeout: 10_000 });
      if (!winner.stdout.startsWith(`go version ${version} `)) {
        throw new Error("The Scope transfer compiler cache is incomplete.");
      }
    }
    return executable;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function collectLicenses(go: string, source: string, output: string) {
  const metadata = await exec(go, ["version", "-m", output]);
  const linked = [...metadata.stdout.matchAll(/^\tdep\t([^\t]+)\t([^\t]+).*$/gm)];
  const modules = await exec(go, ["list", "-m", "-f", "{{.Path}}\t{{.Version}}\t{{.Dir}}", "all"], {
    cwd: source,
    env: { ...process.env, GOTOOLCHAIN: "local" },
  });
  const directories = new Map(
    modules.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [path, , directory] = line.split("\t");
        return [path, directory];
      }),
  );
  const destination = join(desktop, "dist/transfer-licenses");
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  const notices = [
    "# Native transfer licenses",
    "",
    "These files cover the modules linked into scope-tailcat.",
    "",
  ];
  const standardLibrary = await exec(go, ["env", "GOROOT"]);
  await copyLicenseFiles("Go standard library", version, standardLibrary.stdout.trim());
  for (const [, path, dependencyVersion] of linked) {
    const directory = directories.get(path);
    if (!directory) throw new Error(`Missing native transfer license source for ${path}.`);
    await copyLicenseFiles(path, dependencyVersion, directory);
  }
  await writeFile(join(destination, "NOTICE.md"), `${notices.join("\n")}\n`);

  async function copyLicenseFiles(path: string, dependencyVersion: string, directory: string) {
    const identifier = `${path.replaceAll("/", "__").replaceAll(" ", "-")}@${dependencyVersion}`;
    const files = (await readdir(directory))
      .filter((name) =>
        /^(licenses?|licences?|copying|notice|copyright|patents)([._-]|$)/i.test(name),
      )
      .sort();
    if (files.length === 0) throw new Error(`Missing native transfer license for ${path}.`);
    await mkdir(join(destination, identifier));
    notices.push(`## ${path} ${dependencyVersion}`, "");
    for (const file of files) {
      await copyNotice(join(directory, file), join(destination, identifier, file));
      notices.push(`- [${file}](${identifier}/${file})`);
    }
    notices.push("");
  }
}

async function copyNotice(source: string, destination: string) {
  if ((await stat(source)).isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      await copyNotice(join(source, name), join(destination, name));
    }
  } else {
    await writeFile(destination, await readFile(source), { mode: 0o644 });
  }
}

const desktop = resolve(import.meta.dirname, "../apps/desktop");
const source = join(desktop, "transfer-transport");
const output = join(desktop, "dist/scope-tailcat");
const go = await pinnedGo();
await mkdir(join(desktop, "dist"), { recursive: true });
await exec(go, ["build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
  cwd: source,
  env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
  timeout: 300_000,
  maxBuffer: 4 * 1024 * 1024,
});
const result = await exec(output, ["--version"], { timeout: 10_000 });
if (result.stdout.trim() !== "scope-tailcat tailcat/v0.7.0") {
  throw new Error("The bundled Scope transfer transport has an unexpected version.");
}
await collectLicenses(go, source, output);
