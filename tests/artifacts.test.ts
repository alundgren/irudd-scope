import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const hub = await startHub({ directory, token, port: 0 });
  cleanup.push(hub.close);
  const client = new ScopeClient(hub.url, token);
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: { ...process.env, SCOPE_ENDPOINT: hub.url, SCOPE_TOKEN: token },
      maxBuffer: 2 * 1024 * 1024,
    });
  return { directory, hub, client, cli };
}

test("the real CLI publishes every initial kind, updates a stable ID, and data survives a hub restart", async () => {
  const { directory, hub, client, cli } = await fixture();
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
  await hub.close();
  const restarted = await startHub({ directory, token, port: 0 });
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
  const { hub, client, directory } = await fixture();
  expect((await fetch(`${hub.url}/v1/artifacts`)).status).toBe(401);
  const headers = { Authorization: `Bearer ${token}` };
  expect(
    (
      await fetch(`${hub.url}/v1/artifacts`, {
        headers: { ...headers, Origin: "https://untrusted.invalid" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${hub.url}/v1/artifacts/bad`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ title: "Bad", blob: "../../file" }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${hub.url}/v1/blobs`, {
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
