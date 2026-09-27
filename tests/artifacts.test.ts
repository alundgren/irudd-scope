import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startArtifactServer } from "../apps/desktop/src/artifacts/server.ts";
import { startLocalArtifacts } from "../apps/desktop/src/artifacts/local.ts";
import { startHub } from "../apps/hub/src/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { MAX_CONTENT_BYTES, type LiveEvent } from "@irudd-scope/protocol";

const token = "synthetic-test-token-for-scope-only";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-artifacts-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: { ...process.env, SCOPE_ENDPOINT: server.url, SCOPE_TOKEN: token },
      maxBuffer: 2 * 1024 * 1024,
    });
  return { directory, server, client, cli };
}

test("the real CLI publishes every initial kind, updates a stable ID, and data survives a storage restart", async () => {
  const { directory, server, client, cli } = await fixture();
  await cli("text", "A finding", "--title", "Review", "--id", "review");
  const samples = [
    ["review.md", "markdown", "# Review\nA useful finding"],
    ["preview.html", "html", "<h1>Preview</h1>"],
    ["screenshot.png", "image", "synthetic-image-bytes"],
    ["build.zip", "file", "synthetic-archive-bytes"],
  ];
  for (const [fileName, kind, body] of samples) {
    const file = join(directory, fileName);
    await writeFile(file, body);
    const { stdout } = await cli("add", file, "--id", kind);
    expect(JSON.parse(stdout).kind).toBe(kind);
    expect(new TextDecoder().decode(await client.content(kind))).toBe(body);
  }
  const replacement = join(directory, "updated.txt");
  await writeFile(replacement, "A corrected finding");
  await cli("update", "review", replacement);
  expect(await client.get("review")).toMatchObject({ id: "review", title: "Review", revision: 2 });
  cleanup.pop();
  await server.close();
  const restarted = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(restarted.close);
  const reopened = new ScopeClient(restarted.url, token);
  expect(await reopened.list()).toHaveLength(5);
  expect(new TextDecoder().decode(await reopened.content("review"))).toBe("A corrected finding");
});

test("live notifications announce publication and rejected concurrent updates preserve content", async () => {
  const { client, cli } = await fixture();
  const controller = new AbortController();
  const events: LiveEvent[] = [];
  const watching = client.watch((event) => events.push(event), controller.signal).catch(() => {});
  cleanup.push(async () => {
    controller.abort();
    await watching;
  });
  await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);
  await cli("text", "Original", "--id", "architecture");
  await expect
    .poll(() =>
      events.some((event) => event.type === "artifact" && event.artifact.id === "architecture"),
    )
    .toBe(true);
  const artifact = await client.get("architecture");
  const metadata = {
    title: artifact.title,
    kind: artifact.kind,
    fileName: artifact.fileName,
    mediaType: artifact.mediaType,
    expectedRevision: artifact.revision,
  };
  await client.publish(artifact.id, metadata, new TextEncoder().encode("New version"));
  await expect(
    client.publish(artifact.id, metadata, new TextEncoder().encode("Stale edit")),
  ).rejects.toMatchObject({ status: 409 });
  await expect(client.content(artifact.id, 1)).rejects.toMatchObject({ status: 409 });
  expect(new TextDecoder().decode(await client.content(artifact.id))).toBe("New version");
});

test("authentication, invalid metadata, and oversized content fail without creating artifacts", async () => {
  const { server, client, directory } = await fixture();
  expect((await fetch(`${server.url}/v1/artifacts`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${token}` };
  expect(
    (
      await fetch(`${server.url}/v1/artifacts`, {
        headers: { ...headers, Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${server.url}/v1/artifacts/bad`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: "Bad", blob: "../../file" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${server.url}/v1/blobs`, {
        method: "POST",
        headers,
        body: new Uint8Array(MAX_CONTENT_BYTES + 1),
      })
    ).status,
  ).toBe(413);
  expect(await client.list()).toEqual([]);
  const bytes = await readFile(join(directory, "scope.db"));
  expect(bytes.includes(Buffer.from(token))).toBe(false);
});

test("the optional hub forwards live publications and rejects unavailable desktops without replay", async () => {
  const { directory, server, client } = await fixture();
  const hub = await startHub({ endpoint: server.url, token, port: 0 });
  cleanup.push(hub.close);
  const forwarded = new ScopeClient(hub.url, token);
  expect((await fetch(`${hub.url}/v1/artifacts`)).status).toBe(401);
  expect(
    (
      await fetch(`${hub.url}/v1/artifacts`, {
        headers: { Authorization: `Bearer ${token}`, Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  const controller = new AbortController();
  const events: LiveEvent[] = [];
  const watching = forwarded
    .watch((event) => events.push(event), controller.signal)
    .catch(() => {});
  cleanup.push(async () => {
    controller.abort();
    await watching;
  });
  await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);
  const metadata = {
    title: "Via hub",
    kind: "text",
    mediaType: "text/plain",
    fileName: "note.txt",
    expectedRevision: 0,
  };
  const bytes = new TextEncoder().encode("Stored on the Mac");
  await forwarded.publish("forwarded", metadata, bytes);
  await expect
    .poll(() =>
      events.some((event) => event.type === "artifact" && event.artifact.id === "forwarded"),
    )
    .toBe(true);
  expect(await client.content("forwarded")).toEqual(bytes);
  await expect(forwarded.publish("forwarded", metadata, bytes)).rejects.toMatchObject({
    status: 409,
  });
  controller.abort();
  await watching;
  await server.close();
  await expect(forwarded.publish("offline", metadata, bytes)).rejects.toMatchObject({
    status: 503,
  });
  const restarted = await startArtifactServer({
    directory,
    token,
    port: Number(new URL(server.url).port),
  });
  cleanup.push(restarted.close);
  expect((await forwarded.list()).map((artifact) => artifact.id)).toEqual(["forwarded"]);
  await forwarded.publish("after-restart", metadata, bytes);
  expect((await forwarded.list()).map((artifact) => artifact.id)).toEqual([
    "after-restart",
    "forwarded",
  ]);
});

test("the CLI never sends local discovery credentials to an explicitly selected endpoint", async () => {
  const { directory, server, client } = await fixture();
  const file = join(directory, "connection.json");
  await writeFile(file, JSON.stringify({ version: 1, endpoint: server.url, token }));
  const env = {
    ...process.env,
    SCOPE_CONNECTION_FILE: file,
    SCOPE_ENDPOINT: server.url,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
  };
  await expect(
    exec(
      process.execPath,
      [resolve("packages/cli/dist/main.mjs"), "text", "Should fail", "--id", "unexpected"],
      { env },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("An explicit endpoint needs"),
  });
  expect(await client.list()).toEqual([]);
});

test("a failed local listener leaves the existing discovery file and library usable", async () => {
  const { directory, server, cli, client } = await fixture();
  await cli("text", "Original library", "--id", "original");
  const connectionFile = join(directory, "connection.json");
  const connection = JSON.stringify({ version: 1, endpoint: server.url, token });
  await writeFile(connectionFile, connection);
  await expect(
    startLocalArtifacts({
      directory: join(directory, "another-library"),
      connectionFile,
      port: Number(new URL(server.url).port),
    }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(await readFile(connectionFile, "utf8")).toBe(connection);
  expect(new TextDecoder().decode(await client.content("original"))).toBe("Original library");
});
