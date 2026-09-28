import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const identifier = "alundgren.irudd-scope.credentials";

export async function packageCredentialHelper(options: {
  output: string;
  identity: string;
  reusable?: string;
  keychain?: string;
}) {
  if (process.platform !== "darwin" || !/^[0-9A-F]{40}$/.test(options.identity))
    throw new Error("The credential helper requires macOS and a signing certificate fingerprint.");
  const source = new URL("../apps/desktop/native/credentials.m", import.meta.url);
  const flags = [
    "-Os",
    "-fobjc-arc",
    "-Werror",
    "-Wno-deprecated-declarations",
    "-mmacosx-version-min=12.0",
    "-arch",
    process.arch === "arm64" ? "arm64" : "x86_64",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
  ];
  const signingFlags = ["--identifier", identifier, "--options", "runtime", "--timestamp=none"];
  const version = createHash("sha256")
    .update(await readFile(source))
    .update(JSON.stringify({ flags, signingFlags }))
    .digest("hex");
  const requirement = `identifier "${identifier}" and certificate leaf = H"${options.identity}"`;
  async function verify(path: string) {
    await exec("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, path], {
      timeout: 30_000,
    });
    return (await exec(path, ["--version"], { timeout: 10_000, maxBuffer: 1024 })).stdout.trim();
  }
  if (options.reusable) {
    const previousVersion = await verify(options.reusable).catch(() => undefined);
    if (previousVersion === version) {
      await cp(options.reusable, options.output);
      if ((await verify(options.output)) !== version)
        throw new Error("The copied credential helper did not match its source version.");
      return;
    }
  }
  await exec(
    "/usr/bin/xcrun",
    [
      "clang",
      ...flags,
      `-DSCOPE_CREDENTIAL_HELPER_VERSION="${version}"`,
      fileURLToPath(source),
      "-o",
      options.output,
    ],
    { timeout: 60_000 },
  );
  await exec(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      options.identity,
      ...signingFlags,
      ...(options.keychain ? ["--keychain", options.keychain] : []),
      options.output,
    ],
    { timeout: 120_000 },
  );
  if ((await verify(options.output)) !== version)
    throw new Error("The credential helper did not match its source version.");
}
