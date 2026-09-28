import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { macCredentials } from "../apps/desktop/src/credentials.ts";
import { CREDENTIAL_HELPER_NAME } from "../apps/desktop/src/credential-helper.ts";
import { packageCredentialHelper } from "./package-credential-helper.ts";

if (process.platform !== "darwin")
  throw new Error("Native credential verification requires macOS.");
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "scope-native-credentials-"));
const keychain = join(directory, "verification.keychain-db");
const password = randomUUID();
const originalKeychain = process.env.SCOPE_CREDENTIALS_KEYCHAIN;
const security = (...args: string[]) => exec("/usr/bin/security", args, { timeout: 30_000 });
let created = false;
async function removeFromSearchList() {
  const { stdout } = await security("list-keychains", "-d", "user");
  const paths = [...stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  if (paths.includes(keychain))
    await security(
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...paths.filter((path) => path !== keychain),
    );
}
try {
  await security("create-keychain", "-p", password, keychain);
  created = true;
  const search = await security("list-keychains", "-d", "user");
  const paths = [...search.stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  await security("list-keychains", "-d", "user", "-s", ...paths, keychain);
  process.env.SCOPE_CREDENTIALS_KEYCHAIN = keychain;
  await writeFile(
    join(directory, "certificate.cnf"),
    `[req]
distinguished_name = name
x509_extensions = extensions
prompt = no
[name]
CN = Scope synthetic credential verification
[extensions]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = codeSigning
`,
  );
  async function identity(name: string) {
    const key = join(directory, `${name}.key`);
    const certificate = join(directory, `${name}.crt`);
    const archive = join(directory, `${name}.p12`);
    await exec("/usr/bin/openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-x509",
      "-days",
      "1",
      "-config",
      join(directory, "certificate.cnf"),
      "-keyout",
      key,
      "-out",
      certificate,
    ]);
    await exec("/usr/bin/openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      key,
      "-in",
      certificate,
      "-out",
      archive,
      "-passout",
      `pass:${password}`,
    ]);
    await security("import", archive, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign");
    await security(
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      keychain,
    );
    const { stdout } = await exec("/usr/bin/openssl", [
      "x509",
      "-in",
      certificate,
      "-noout",
      "-fingerprint",
      "-sha1",
    ]);
    const fingerprint = stdout.trim().split("=")[1]!.replaceAll(":", "");
    const identities = await security("find-identity", "-p", "codesigning", keychain);
    assert.ok(identities.stdout.includes(fingerprint), identities.stdout);
    return fingerprint;
  }
  const fingerprint = await identity("signer");
  const otherFingerprint = await identity("other-signer");
  const firstDirectory = join(directory, "first");
  const secondDirectory = join(directory, "second");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const firstHelper = join(firstDirectory, CREDENTIAL_HELPER_NAME);
  const secondHelper = join(secondDirectory, CREDENTIAL_HELPER_NAME);
  await packageCredentialHelper({ output: firstHelper, identity: fingerprint, keychain });
  await packageCredentialHelper({
    output: secondHelper,
    identity: fingerprint,
    keychain,
    reusable: firstHelper,
  });
  assert.deepEqual(await readFile(secondHelper), await readFile(firstHelper));

  async function caller(
    name: string,
    helper: string,
    signer: string,
    identifier = "alundgren.irudd-scope",
  ) {
    const path = join(directory, name);
    await exec("/usr/bin/xcrun", [
      "clang",
      "-Os",
      "-Wno-deprecated-declarations",
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      `-DCREDENTIAL_HELPER_PATH=${JSON.stringify(helper)}`,
      fileURLToPath(new URL("../tests/fixtures/credential-parent.c", import.meta.url)),
      "-o",
      path,
    ]);
    await exec("/usr/bin/codesign", [
      "--force",
      "--sign",
      signer,
      "--identifier",
      identifier,
      "--timestamp=none",
      "--keychain",
      keychain,
      path,
    ]);
    return path;
  }
  const firstCaller = await caller("Scope version one", firstHelper, fingerprint);
  const secondCaller = await caller("Scope version two", secondHelper, fingerprint);
  const wrongApp = await caller("Different app", firstHelper, fingerprint, "example.other-app");
  const wrongSigner = await caller("Different signer", firstHelper, otherFingerprint);
  const adHoc = await caller("Ad-hoc app", firstHelper, "-");
  const codeHash = async (path: string) =>
    (await exec("/usr/bin/codesign", ["-dvvv", path])).stderr.match(/^CDHash=(.+)$/m)![1];
  assert.notEqual(await codeHash(firstCaller), await codeHash(secondCaller));
  assert.equal(await codeHash(firstHelper), await codeHash(secondHelper));

  const waiting = spawn(firstCaller, [], { stdio: ["pipe", "ignore", "pipe"] });
  const finished = once(waiting, "close");
  const [message] = await once(waiting.stderr, "data");
  const helperPid = Number(String(message).match(/helper pid: (\d+)/)![1]);
  try {
    await delay(100);
    waiting.kill("SIGKILL");
    await Promise.race([
      finished,
      delay(5_000).then(() => {
        throw new Error("The helper stayed alive after its parent exited.");
      }),
    ]);
  } finally {
    waiting.kill("SIGKILL");
    try {
      process.kill(helperPid, "SIGKILL");
    } catch {
      /* The helper has already exited. */
    }
    waiting.stdin.destroy();
  }

  const legacyProfile = join(directory, "existing-profile");
  const legacyAccount = createHash("sha256").update(legacyProfile).digest("hex");
  const legacySecrets = {
    apiKey: "synthetic-existing-key",
    remoteTokens: { remote: "synthetic-existing-token" },
  };
  // The fixture grants the permission that the user approves on the helper's first access.
  await security(
    "add-generic-password",
    "-s",
    "alundgren.irudd-scope",
    "-a",
    legacyAccount,
    "-w",
    JSON.stringify(legacySecrets),
    "-T",
    firstHelper,
    keychain,
  );
  const migrated = await macCredentials(legacyProfile, secondCaller);
  assert.deepEqual(await migrated.read(), legacySecrets);

  const profile = join(directory, "profile");
  const first = await macCredentials(profile, firstCaller);
  const second = await macCredentials(profile, secondCaller);
  const secrets = {
    apiKey: "synthetic-provider-key-å",
    remoteTokens: { remote: "synthetic-remote-token" },
  };
  assert.deepEqual(await first.read(), {});
  await first.write(secrets);
  await assert.rejects(
    exec(firstCaller, [
      "--read-direct",
      keychain,
      createHash("sha256").update(profile).digest("hex"),
    ]),
  );
  assert.deepEqual(await second.read(), secrets);
  const changed = { ...secrets, apiKey: "synthetic-replacement-key" };
  await second.write(changed);
  assert.deepEqual(await first.read(), changed);
  for (const executable of [firstHelper, wrongApp, wrongSigner, adHoc]) {
    const rejected = await macCredentials(profile, executable);
    await assert.rejects(rejected.read());
    await assert.rejects(rejected.write({ apiKey: "must-not-be-saved" }));
    await assert.rejects(rejected.write({}));
    assert.deepEqual(await second.read(), changed);
  }
  await security("lock-keychain", keychain);
  await assert.rejects(second.read());
  await security("unlock-keychain", "-p", password, keychain);
  assert.deepEqual(await second.read(), changed);
  const samples = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    assert.deepEqual(await second.read(), changed);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const measurement = exec(secondCaller, [], { env: { SCOPE_CREDENTIALS_KEYCHAIN: keychain } });
  measurement.child.stdin!.end(
    JSON.stringify({
      operation: "read",
      account: createHash("sha256").update(profile).digest("hex"),
    }),
  );
  const measured = await measurement;
  assert.deepEqual(JSON.parse(JSON.parse(measured.stdout)), changed);
  const peakMemory = Number(measured.stderr.match(/helper peak RSS bytes: (\d+)/)![1]);
  await second.write({});
  assert.deepEqual(await first.read(), {});
  await second.write({});
  console.log(
    "Passed: unchanged helper across changed callers; credentials preserved; unauthorized callers and locked Keychain rejected; deletion.",
  );
  console.log(
    `Warm credential reads: median ${samples[10]!.toFixed(1)} ms, maximum ${samples[19]!.toFixed(1)} ms across 20 runs.`,
  );
  console.log(
    `Helper peak resident memory: ${(peakMemory / 1024 / 1024).toFixed(1)} MiB; process exits after each request.`,
  );
} finally {
  if (originalKeychain === undefined) delete process.env.SCOPE_CREDENTIALS_KEYCHAIN;
  else process.env.SCOPE_CREDENTIALS_KEYCHAIN = originalKeychain;
  if (created) {
    await removeFromSearchList();
    await security("delete-keychain", keychain);
  }
  await rm(directory, { recursive: true, force: true });
}
