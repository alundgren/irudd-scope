import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { macCredentials } from "../apps/desktop/src/credentials.ts";

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "scope-credential-client-"));
  const executable = join(directory, "credential-helper.cjs");
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { directory, executable };
}

test("credential processes preserve Unicode values and isolate desktop profiles through private pipes", async () => {
  const { directory, executable } = await fixture(`
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => input += value);
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'launch.json'), JSON.stringify({args: process.argv, env: process.env}));
  const request = JSON.parse(input);
  const saved = path.join(__dirname, request.account);
  let result = null;
  if (request.operation === 'write') fs.writeFileSync(saved, request.value);
  if (request.operation === 'delete') fs.rmSync(saved, {force: true});
  if (request.operation === 'read' && fs.existsSync(saved)) result = fs.readFileSync(saved, 'utf8');
  process.stdout.write(JSON.stringify(result));
});
`);
  try {
    const profile = join(directory, "first profile");
    const first = await macCredentials(profile, executable);
    const restarted = await macCredentials(profile, executable);
    const otherProfile = await macCredentials(join(directory, "other profile"), executable);
    const secrets = {
      apiKey: 'synthetic-secret-å-🔑-"-\n-value',
      remoteTokens: { remote: "synthetic-remote-credential" },
    };
    expect(await first.read()).toEqual({});
    await first.write(secrets);
    const launch = await readFile(join(directory, "launch.json"), "utf8");
    expect(launch).not.toContain("synthetic-secret");
    expect(launch).not.toContain("synthetic-remote-credential");
    expect(await restarted.read()).toEqual(secrets);
    expect(await otherProfile.read()).toEqual({});
    await restarted.write({ remoteTokens: secrets.remoteTokens });
    expect(await first.read()).toEqual({ remoteTokens: secrets.remoteTokens });
    await first.write({});
    expect(await restarted.read()).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.for([
  'process.stdout.write("invalid synthetic-secret-response")',
  'process.stdout.write(JSON.stringify({apiKey: "synthetic-secret-response"}))',
  'process.stdout.write("synthetic-secret-response"); process.stderr.write("synthetic-secret-response"); process.exitCode = 3',
  'process.stdout.write("synthetic-secret-response".repeat(100_000))',
])(
  "helper failures never expose response bytes or become missing credentials: %s",
  async (source) => {
    const { directory, executable } = await fixture(source);
    try {
      const credentials = await macCredentials(directory, executable);
      const error = await credentials.read().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        "Could not read Scope credentials from macOS Keychain.",
      );
      expect(inspect(error)).not.toContain("synthetic-secret-response");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("an unavailable helper fails without falling back to another credential store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-missing-helper-"));
  try {
    const credentials = await macCredentials(directory, join(directory, "missing"));
    await expect(credentials.read()).rejects.toThrow("Could not read Scope credentials");
    await expect(credentials.write({ apiKey: "synthetic-secret" })).rejects.toThrow(
      "Could not update Scope credentials",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
