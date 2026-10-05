import { afterEach, expect, test } from "vite-plus/test";
import { request, type ClientRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, MAX_CONTENT_BYTES, PublicationReceipt } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const token = "synthetic-publication-limits-token";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-publication-limits-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(server.close);
  return { server, client: new ScopeClient(server.url, token) };
}

test.each([
  { name: "empty", token: "" },
  { name: "carriage return", token: "synthetic\rtoken" },
  { name: "line feed", token: "synthetic\ntoken" },
])("the client rejects $name bearer tokens", ({ token }) => {
  expect(() => new ScopeClient("http://127.0.0.1:1", token)).toThrow("A bearer token is required.");
});

test("the client publishes exactly 32 MiB and rejects content above the limit", async () => {
  const { client } = await fixture();
  const metadata = {
    title: "Content limit",
    kind: "file",
    mediaType: "application/octet-stream",
    fileName: "boundary.bin",
    expectedRevision: 0,
  };
  const content = Buffer.alloc(MAX_CONTENT_BYTES, 17);
  await expect(client.publish("at-limit", metadata, content)).resolves.toMatchObject({
    id: "at-limit",
    size: MAX_CONTENT_BYTES,
    revision: 1,
  });
  const received = await client.content("at-limit");
  expect(createHash("sha256").update(received).digest("hex")).toBe(
    createHash("sha256").update(content).digest("hex"),
  );
  await expect(
    client.publish("over-limit", metadata, Buffer.alloc(MAX_CONTENT_BYTES + 1)),
  ).rejects.toThrow("32 MiB limit");
  await expect(client.get("over-limit")).rejects.toMatchObject({ status: 404 });
});

test("four unfinished uploads reject a fifth and cancellation releases their capacity", async () => {
  const { server, client } = await fixture();
  const headers = { Authorization: `Bearer ${token}` };
  const tabs: string[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await fetch(`${server.url}/v1/artifacts/upload-limit-${index}/tab`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(response.ok).toBe(true);
    tabs.push(decode(PublicationReceipt, await response.json()).tabId);
  }

  const held: ClientRequest[] = [];
  const closed: Promise<void>[] = [];
  try {
    for (const tabId of tabs.slice(0, 4)) {
      const upload = request(`${server.url}/v1/tabs/${tabId}/blobs`, {
        method: "POST",
        headers: { ...headers, Expect: "100-continue", "Content-Length": "2" },
      });
      held.push(upload);
      closed.push(new Promise<void>((resolve) => upload.once("close", resolve)));
      const ready = new Promise<void>((resolve, reject) => {
        upload.once("continue", resolve);
        upload.once("error", reject);
        upload.once("response", (response) => {
          response.resume();
          reject(new Error(`Upload finished before its body: ${response.statusCode}`));
        });
      });
      upload.flushHeaders();
      await ready;
      upload.write("a");
    }
    const response = await fetch(`${server.url}/v1/tabs/${tabs[4]}/blobs`, {
      method: "POST",
      headers,
      body: "a",
    });
    expect(response.status).toBe(503);
    await response.body?.cancel();
  } finally {
    for (const upload of held) upload.destroy();
    await Promise.all(closed);
  }

  await expect(
    client.publish(
      "after-cancellation",
      {
        title: "Available again",
        kind: "text",
        mediaType: "text/plain",
        fileName: "ready.txt",
        expectedRevision: 0,
      },
      Buffer.from("Ready"),
    ),
  ).resolves.toMatchObject({ id: "after-cancellation", size: 5 });
});
