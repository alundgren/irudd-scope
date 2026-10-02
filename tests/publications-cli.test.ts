import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { PublicationsCommand, PublicationsReply } from "@irudd-scope/protocol/publications";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-publications-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const token = "synthetic-publications-cli-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
      timeout: 15000,
    });
  const apply = async (command: PublicationsCommand) => {
    const file = join(directory, `${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(command));
    return cli("publications", "apply", file);
  };
  return { directory, client, cli, apply };
}

test("the built CLI exports immutable prepared HTML, refuses replacement files, and recovers a completion receipt", async () => {
  const f = await fixture();
  const html = "<!doctype html><h1>Published exactly</h1><script>window.example = 1</script>";
  const source = join(f.directory, "source.html");
  await writeFile(source, html);
  await f.cli("add", source, "--id", "cli-presentation");
  const read: PublicationsReply = JSON.parse(
    (await f.cli("publications", "read", "cli-presentation")).stdout,
  );
  const address = {
    id: read.snapshot.artifact.id,
    tabId: read.snapshot.tabId,
    provider: "claude" as const,
    operationId: randomUUID(),
  };
  await f.apply({
    ...address,
    action: "prepare",
    expectedRevision: 1,
    observation: {
      accountId: "synthetic-account",
      workspaceId: null,
      remoteId: null,
      url: null,
      access: "owner",
      audience: "owner",
      evidence: "documented-private-default",
      checkedAt: new Date().toISOString(),
      marker: { version: null, updatedAt: null },
      conditionalWrite: true,
    },
  });
  const output = join(f.directory, "export.html");
  const exported = JSON.parse(
    (await f.cli("publications", "content", address.id, address.operationId, "--output", output))
      .stdout,
  );
  expect(exported.revision).toBe(1);
  expect(await readFile(output, "utf8")).toBe(html);
  await expect(
    f.cli("publications", "content", address.id, address.operationId, "--output", output),
  ).rejects.toThrow("EEXIST");
  await f.apply({ ...address, action: "start" });
  await writeFile(source, "<h1>New unpublished revision</h1>");
  await f.cli("update", address.id, source);
  const completion: PublicationsCommand = {
    ...address,
    action: "complete",
    result: {
      provider: "claude",
      remoteId: "cli-remote",
      url: "https://claude.ai/code/artifact/cli-remote",
      savedVersion: null,
      sourceCommit: null,
      deploymentId: null,
      marker: { version: "1", updatedAt: null },
      confirmedAt: new Date().toISOString(),
      state: "succeeded",
    },
  };
  const first = JSON.parse((await f.apply(completion)).stdout);
  const retry = JSON.parse((await f.apply(completion)).stdout);
  expect(retry.snapshot.destinations).toEqual(first.snapshot.destinations);
  expect(retry.snapshot.artifact.revision).toBe(2);
  expect(retry.snapshot.destinations[0].checkpoint.revision).toBe(1);
  const recovered = join(f.directory, "recovered.html");
  await f.cli("publications", "content", address.id, address.operationId, "--output", recovered);
  expect(await readFile(recovered, "utf8")).toBe(html);
});

test("the CLI returns a nonzero privacy decision before any operation is permitted", async () => {
  const f = await fixture();
  await f.client.publish(
    "private-check",
    {
      title: "Synthetic",
      kind: "html",
      mediaType: "text/html",
      fileName: "test.html",
      expectedRevision: 0,
    },
    Buffer.from("<h1>Test</h1>"),
  );
  const { snapshot } = await f.client.publications({ action: "read", id: "private-check" });
  try {
    await f.apply({
      id: snapshot.artifact.id,
      tabId: snapshot.tabId,
      provider: "claude",
      operationId: randomUUID(),
      action: "prepare",
      expectedRevision: 1,
      observation: {
        accountId: "synthetic-account",
        workspaceId: null,
        remoteId: "external",
        url: "https://claude.ai/code/artifact/external",
        access: "owner",
        audience: "public",
        evidence: "authenticated-share-inspection",
        checkedAt: new Date().toISOString(),
        marker: { version: "1", updatedAt: null },
        conditionalWrite: true,
      },
    });
    throw new Error("Public destination was permitted");
  } catch (error) {
    const result = error as Error & { code: number; stdout: string };
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).decision).toBe("blocked");
  }
  expect(
    (await f.client.publications({ action: "read", id: snapshot.artifact.id })).snapshot
      .destinations,
  ).toEqual([]);
});
