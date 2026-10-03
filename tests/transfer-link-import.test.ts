import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { readTransferUrl, transferUrl, TRANSFER_LIFETIME_MS } from "@irudd-scope/protocol/transfer";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { startHub } from "../apps/hub/src/server.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { HubState } from "../apps/hub/src/state.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";
import { transferFixture } from "./transfer-fixture.ts";

const exec = promisify(execFile);
const token = "synthetic-transfer-publishing-token";

async function receiver(f: Awaited<ReturnType<typeof transferFixture>>, available = true) {
  return startArtifactServer({
    directory: join(f.directory, "work", "artifacts"),
    token,
    port: 0,
    importLink: available ? (url) => f.target.service.importLink(url) : undefined,
  });
}

function cli(connectionFile: string, ...args: string[]) {
  return exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
    env: {
      ...process.env,
      SCOPE_CONNECTION_FILE: connectionFile,
      SCOPE_ENDPOINT: undefined,
      SCOPE_TOKEN: undefined,
      SCOPE_TOKEN_FILE: undefined,
    },
    timeout: 60_000,
    maxBuffer: 128 * 1024,
  });
}

test.each(["local", "forwarding hub", "paired hub"])(
  "an agent imports a sharing link through %s without a desktop confirmation",
  async (mode) => {
    const f = await transferFixture();
    const server = await receiver(f);
    const closers: (() => Promise<unknown> | void)[] = [];
    try {
      const { peerId, secret } = await f.pair();
      const published = await f.publish();
      const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
      const connectionFile = join(f.directory, "receiver-connection.json");
      let endpoint = server.url;
      let publishingToken = token;
      let remotes: Remotes | undefined;
      if (mode === "forwarding hub") {
        const hub = await startHub({ endpoint: server.url, token, port: 0 });
        closers.push(hub.close);
        endpoint = hub.url;
      } else if (mode === "paired hub") {
        const state = await HubState.open(join(f.directory, "hub"));
        closers.push(() => state.close());
        await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
        const hub = await startPairedHub(state, 0);
        closers.push(hub.close);
        await state.configure({
          endpoint: hub.url,
          port: Number(new URL(hub.url).port),
          connectionFile,
        });
        const connection = decodeLocalConnection(
          JSON.parse(await readFile(connectionFile, "utf8")),
        );
        endpoint = connection.endpoint;
        publishingToken = connection.token;
        remotes = new Remotes(f.target.store, { url: server.url, token }, () => {});
        closers.push(() => remotes!.close());
        await remotes.start();
        await remotes.pair(state.pairUrl());
        await expect.poll(() => remotes!.snapshot()[0]?.connection).toBe("connected");
        let delayed = false;
        f.transport.after = async () => {
          if (delayed) return;
          delayed = true;
          // Relay imports must survive the previous 30-second request deadline.
          await delay(31_000);
        };
      }
      await writeFile(
        connectionFile,
        JSON.stringify({ version: 1, endpoint, token: publishingToken }),
        { mode: 0o600 },
      );
      const output = await cli(connectionFile, "import-link", invitation.url);
      const receipt = JSON.parse(output.stdout);
      expect(receipt.alreadyImported).toBe(false);
      expect(receipt.artifact.id).not.toBe(published.artifact.id);
      expect(receipt.artifact.title).toBe("Fixture tab");
      expect(output.stdout).not.toContain(secret);
      expect(await f.target.artifacts.content(receipt.artifact.blob)).toEqual(published.bytes);
      expect(await f.source.artifacts.content(published.artifact.blob)).toEqual(published.bytes);
      expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(1);
      expect(JSON.parse((await cli(connectionFile, "import-link", invitation.url)).stdout)).toEqual(
        { ...receipt, alreadyImported: true },
      );
      if (remotes) {
        await remotes.close();
        await expect(cli(connectionFile, "import-link", invitation.url)).rejects.toMatchObject({
          stderr: expect.stringContaining("disconnected"),
        });
        expect(JSON.parse((await cli(connectionFile, "hub", "queue")).stdout).items).toEqual([]);
      }
    } finally {
      for (const close of closers.reverse()) await close();
      await server.close();
      await f.close();
    }
  },
  60_000,
);

test("link import rejects unauthorized callers, pairing links, tampering and expired invitations", async () => {
  const f = await transferFixture();
  const server = await receiver(f);
  try {
    const { peerId, invitation: pairing } = await f.pair();
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    const post = (
      body: unknown,
      headers: Record<string, string> = {},
      path = "/v1/transfers/import",
    ) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    const calls = f.transport.requests.length;
    expect((await post({ url: invitation.url }, { Authorization: "Bearer wrong" })).status).toBe(
      401,
    );
    expect((await post({ url: invitation.url }, { Origin: "https://example.com" })).status).toBe(
      403,
    );
    expect((await post({ url: pairing.url })).status).toBe(400);
    expect((await post({ url: "invalid" })).status).toBe(400);
    expect((await post({ url: "x".repeat(17 * 1024) })).status).toBe(413);
    expect((await post({ url: invitation.url }, {}, "/v1/transfers/send")).status).toBe(404);
    const altered = { ...readTransferUrl(invitation.url), port: 54321 };
    const changed = await post({ url: transferUrl(altered) });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({
      error: expect.stringContaining("does not match"),
    });
    expect(f.transport.requests).toHaveLength(calls);
    await f.source.service.cancel(invitation.id);
    const cancelled = await post({ url: invitation.url });
    expect(cancelled.status).toBe(400);
    const expiring = await f.source.service.send({ tabId: published.tab.id, peerId });
    f.advance(TRANSFER_LIFETIME_MS);
    const expired = await post({ url: expiring.url });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: expect.stringContaining("expired") });
    expect((await f.target.lifecycle.workspace()).tabs).toEqual([]);
  } finally {
    await server.close();
    await f.close();
  }
});

test("an agent gets an actionable error when link import is unavailable or the sender is unpaired", async () => {
  const f = await transferFixture();
  const unavailable = await receiver(f, false);
  const server = await receiver(f);
  try {
    const { peerId } = await f.pair();
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    const file = join(f.directory, "connection.json");
    await writeFile(file, JSON.stringify({ version: 1, endpoint: unavailable.url, token }));
    await expect(cli(file, "import-link", invitation.url)).rejects.toMatchObject({
      stderr: expect.stringContaining("Link import is unavailable"),
    });
    await writeFile(file, JSON.stringify({ version: 1, endpoint: server.url, token }));
    await f.target.service.forget(peerId);
    await expect(cli(file, "import-link", invitation.url)).rejects.toMatchObject({
      stderr: expect.stringContaining("Pair these Scope instances"),
    });
    await expect(cli(file, "import-link", "invalid")).rejects.toMatchObject({
      stderr: expect.stringContaining("valid Scope transfer link"),
    });
    expect((await f.target.lifecycle.workspace()).tabs).toEqual([]);
  } finally {
    await unavailable.close();
    await server.close();
    await f.close();
  }
});
