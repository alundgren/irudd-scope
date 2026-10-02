import { expect, test } from "vite-plus/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { TabTransfers } from "../apps/desktop/src/transfer/service.ts";
import { decryptTransfer, encryptTransfer } from "../apps/desktop/src/transfer/crypto.ts";
import { readTransferUrl, transferUrl, TRANSFER_LIFETIME_MS } from "@irudd-scope/protocol/transfer";
import type { TransferTransport } from "../apps/desktop/src/transfer/transport.ts";

class LocalTransport implements TransferTransport {
  handlers = new Map<string, (body: string) => Promise<string>>();
  requests: { address: string; port: number; body: string }[] = [];
  after?: (address: string, body: string) => Promise<void>;
  transform?: (address: string, body: string, response: string) => Promise<string>;
  async listen(handler: (body: string) => Promise<string>) {
    const address = `tc${randomBytes(64).toString("base64url")}`;
    this.handlers.set(address, handler);
    return {
      address,
      port: 12345,
      close: async () => {
        this.handlers.delete(address);
      },
    };
  }
  async request(address: string, port: number, body: string) {
    this.requests.push({ address, port, body });
    const handler = this.handlers.get(address);
    if (!handler) throw new Error("Source is unavailable.");
    const response = await handler(body);
    await this.after?.(address, body);
    return this.transform ? this.transform(address, body, response) : response;
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-transfer-"));
  const transport = new LocalTransport();
  let clock = Date.now();
  const instances = await Promise.all(
    ["private", "work", "stranger"].map(async (name) => {
      const credentials = memoryCredentials();
      const store = new DesktopStore(join(directory, name), credentials);
      await store.load();
      const artifacts = await ArtifactStore.open(join(directory, name, "artifacts"));
      const lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
      const service = new TabTransfers(store, lifecycle, transport, () => clock);
      return { name, credentials, store, artifacts, lifecycle, service };
    }),
  );
  const [source, target, stranger] = instances;
  return {
    directory,
    transport,
    source,
    target,
    stranger,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    pair: async () => {
      const invitation = await source.service.createPairing("Private Mac");
      const secret = source.service.pairingSecret(invitation.id);
      await target.service.pair({ url: invitation.url, secret, name: "Work Mac" });
      return { invitation, secret, peerId: readTransferUrl(invitation.url).pairId };
    },
    publish: async (kind = "html", content = "<h1>Transfer fixture</h1>") => {
      const id = `fixture-${randomUUID()}`;
      const tabId = await source.artifacts.reserve(id, 0);
      const bytes = Buffer.from(content);
      const blob = await source.artifacts.upload(
        tabId,
        (async function* () {
          yield bytes;
        })(),
      );
      const artifact = await source.artifacts.put(id, {
        tabId,
        expectedRevision: 0,
        title: "Fixture tab",
        kind,
        mediaType: kind === "excalidraw" ? "application/vnd.excalidraw+json" : "text/html",
        fileName: kind === "excalidraw" ? "fixture.excalidraw" : "fixture.html",
        blob,
      });
      const workspace = await source.lifecycle.workspace();
      const tab = await source.lifecycle.openTab(
        {
          id: tabId,
          groupId: workspace.groups[0].id,
          type: kind === "excalidraw" ? "diagram" : "file",
          title: artifact.title,
          state: { version: 1, data: { artifactId: id } },
        },
        artifact.revision,
      );
      return { artifact, tab: tab!, bytes };
    },
    close: async () => {
      await Promise.all(
        instances.map(async (instance) => {
          await instance.service.close();
          await instance.artifacts.close();
          await instance.store.close();
        }),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("paired Macs copy one tab with a durable retry receipt and retain source content", async () => {
  const f = await fixture();
  try {
    const { peerId, secret } = await f.pair();
    await f.source.store.saveSettings({ apiKey: "synthetic-provider-key" });
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    expect(invitation.expiresAt - Date.now()).toBeLessThanOrEqual(TRANSFER_LIFETIME_MS);
    expect(await f.target.service.inspect(invitation.url)).toMatchObject({
      title: "Fixture tab",
      kind: "html",
      sourceName: "Private Mac",
    });
    const imported = await f.target.service.import(invitation.url);
    expect(imported.alreadyImported).toBe(false);
    expect(imported.artifact.id).not.toBe(published.artifact.id);
    expect(imported.artifact.name).toBeUndefined();
    expect(imported.artifact.source).toBeUndefined();
    expect(await f.target.artifacts.content(imported.artifact.blob)).toEqual(published.bytes);
    expect(await f.source.artifacts.content(published.artifact.blob)).toEqual(published.bytes);
    expect(f.source.service.status(invitation.id).state).toBe("delivered");
    const retry = await f.target.service.import(invitation.url);
    expect(retry).toEqual({ artifact: imported.artifact, alreadyImported: true });
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(1);
    const reopened = await ArtifactStore.open(join(f.directory, "work", "artifacts"));
    try {
      expect(
        (await reopened.transferReceipt(readTransferUrl(invitation.url).sourceId, invitation.id))
          ?.artifact.id,
      ).toBe(imported.artifact.id);
    } finally {
      await reopened.close();
    }
    const db = new DatabaseSync(join(f.directory, "private", "desktop.db"), { readOnly: true });
    try {
      expect(JSON.stringify(db.prepare("SELECT * FROM preferences").all())).not.toContain(secret);
    } finally {
      db.close();
    }
    expect(await f.source.credentials.read()).toMatchObject({
      apiKey: "synthetic-provider-key",
      transferKeys: { [peerId]: secret },
    });
    expect(await f.target.credentials.read()).not.toHaveProperty("apiKey");
  } finally {
    await f.close();
  }
});

test("a copied QR, wrong secret, changed address, and different receiver cannot retrieve a tab", async () => {
  const f = await fixture();
  try {
    const { invitation: pairing, peerId } = await f.pair();
    const calls = f.transport.requests.length;
    await expect(
      f.stranger.service.pair({
        url: pairing.url,
        secret: randomBytes(32).toString("base64url"),
        name: "Stranger",
      }),
    ).rejects.toThrow("does not match");
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    await expect(f.stranger.service.inspect(invitation.url)).rejects.toThrow("Pair these");
    const altered = {
      ...readTransferUrl(invitation.url),
      address: `tc${randomBytes(64).toString("base64url")}`,
    };
    await expect(f.target.service.inspect(transferUrl(altered))).rejects.toThrow("does not match");
    await expect(
      f.target.service.inspect(transferUrl({ ...readTransferUrl(invitation.url), port: 12346 })),
    ).rejects.toThrow("does not match");
    for (const port of [0, 65536, 1.5])
      expect(() => transferUrl({ ...readTransferUrl(invitation.url), port })).toThrow();
    const oldUrl = invitation.url.replace("scope-transfer://v2/", "scope-transfer://v1/");
    expect(() => readTransferUrl(oldUrl)).toThrow("valid Scope transfer link");
    expect(f.transport.requests).toHaveLength(calls);
    expect((await f.stranger.lifecycle.workspace()).tabs).toHaveLength(0);
    await f.source.service.forget(peerId);
    await expect(f.target.service.inspect(invitation.url)).rejects.toThrow();
    expect(await f.source.store.scopePeers()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("Forget rejects a pairing response already in flight", async () => {
  const f = await fixture();
  try {
    const invitation = await f.source.service.createPairing("Private Mac");
    const { pairId } = readTransferUrl(invitation.url);
    f.transport.after = async () => {
      await f.target.service.forget(pairId);
    };
    await expect(
      f.target.service.pair({
        url: invitation.url,
        secret: f.source.service.pairingSecret(invitation.id),
        name: "Work Mac",
      }),
    ).rejects.toThrow("cancelled");
    expect(await f.target.store.scopePeers()).toEqual([]);
    expect(await f.target.store.transferKey(pairId)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("Import rejects authenticated content that differs from the reviewed manifest", async () => {
  const f = await fixture();
  try {
    const { peerId, secret } = await f.pair();
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    const parsed = readTransferUrl(invitation.url);
    await f.target.service.inspect(invitation.url);
    f.transport.transform = async (_address, body, response) => {
      if (
        (decryptTransfer(secret, parsed, "request", body).value as { operation: string })
          .operation !== "content"
      )
        return response;
      const value = decryptTransfer(secret, parsed, "response", response).value as {
        result: { manifest: { title: string } };
      };
      value.result.manifest.title = "Different tab";
      return encryptTransfer(secret, parsed, "response", value);
    };
    await expect(f.target.service.import(invitation.url)).rejects.toThrow(
      "changed after you reviewed",
    );
    expect(f.source.service.status(invitation.id).state).toBe("waiting");
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("invitations expire at exactly fifteen minutes and cancellation preserves both libraries", async () => {
  const f = await fixture();
  try {
    const { peerId } = await f.pair();
    const published = await f.publish();
    const first = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.source.service.cancel(first.id);
    await expect(f.target.service.import(first.url)).rejects.toThrow();
    const second = await f.source.service.send({ tabId: published.tab.id, peerId });
    f.advance(TRANSFER_LIFETIME_MS - 1);
    expect(await f.target.service.inspect(second.url)).toMatchObject({ title: "Fixture tab" });
    f.advance(1);
    await expect(f.target.service.import(second.url)).rejects.toThrow("expired");
    expect(f.source.service.status(second.id).state).toBe("expired");
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(0);
    expect((await f.source.lifecycle.workspace()).tabs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("the current diagram document transfers without conversation, proposals or agent state", async () => {
  const f = await fixture();
  try {
    const { peerId } = await f.pair();
    const published = await f.publish(
      "excalidraw",
      JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }),
    );
    const current = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [{ id: "edited-on-private" }],
      appState: {},
      files: {},
    });
    await f.source.artifacts.saveDiagramDraft(published.tab.id, {
      version: 1,
      content: current,
      revision: published.artifact.revision,
      dirty: true,
      messages: [{ role: "user", text: "Private conversation" }],
      intent: "Private prompt",
      chatOpen: true,
      conversationTarget: "external",
    });
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(invitation.url);
    const imported = await f.target.service.import(invitation.url);
    expect((await f.target.artifacts.content(imported.artifact.blob)).toString()).toBe(current);
    const [tab] = (await f.target.lifecycle.workspace()).tabs;
    expect(tab.type).toBe("diagram");
    expect(await f.target.artifacts.diagramDraft(tab.id)).toBeNull();
    expect((await f.source.artifacts.diagramDraft(published.tab.id))?.messages).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("Cancel wins before final authorization, and cannot retract an authorized import", async () => {
  const f = await fixture();
  try {
    const { peerId, secret } = await f.pair();
    const published = await f.publish();
    const first = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(first.url);
    let invitation = readTransferUrl(first.url);
    f.transport.after = async (_address, body) => {
      const value = decryptTransfer(secret, invitation, "request", body).value as {
        operation: string;
      };
      if (value.operation === "content") await f.source.service.cancel(first.id);
    };
    await expect(f.target.service.import(first.url)).rejects.toThrow();
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(0);
    f.transport.after = undefined;
    const second = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(second.url);
    invitation = readTransferUrl(second.url);
    f.transport.after = async (_address, body) => {
      const value = decryptTransfer(secret, invitation, "request", body).value as {
        operation: string;
      };
      if (value.operation === "authorize")
        await expect(f.source.service.cancel(second.id)).rejects.toThrow(
          "already started importing",
        );
    };
    await f.target.service.import(second.url);
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("retry opens the receiver's latest independently edited copy", async () => {
  const f = await fixture();
  try {
    const { peerId } = await f.pair();
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(invitation.url);
    const imported = await f.target.service.import(invitation.url);
    const edited = await f.target.artifacts.replaceContent(
      imported.artifact.id,
      imported.artifact.revision,
      "Edited on Work Mac",
      Buffer.from("<h1>Work edits</h1>"),
    );
    expect(await f.target.service.import(invitation.url)).toEqual({
      artifact: edited,
      alreadyImported: true,
    });
    expect(await f.target.service.inspect(invitation.url)).toMatchObject({
      title: "Edited on Work Mac",
      alreadyImported: true,
    });
    expect((await f.source.artifacts.content(published.artifact.blob)).toString()).toBe(
      published.bytes.toString(),
    );
  } finally {
    await f.close();
  }
});

test("replaying pairing requests does not repeat pairing and removed imports cannot be recreated", async () => {
  const f = await fixture();
  try {
    const { peerId } = await f.pair();
    const request = f.transport.requests[0];
    await f.transport.request(request.address, request.port, request.body);
    expect(await f.source.store.scopePeers()).toHaveLength(1);
    const published = await f.publish();
    const invitation = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(invitation.url);
    const imported = await f.target.service.import(invitation.url);
    await f.target.lifecycle.deleteArtifact(imported.artifact.id);
    await expect(f.target.service.import(invitation.url)).rejects.toThrow("already imported");
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("expiry after download blocks commit and a lost receipt acknowledgement still permits safe retries", async () => {
  const f = await fixture();
  try {
    const { peerId, secret } = await f.pair();
    const published = await f.publish();
    const first = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(first.url);
    let invitation = readTransferUrl(first.url);
    f.transport.after = async (_address, body) => {
      if (
        (decryptTransfer(secret, invitation, "request", body).value as { operation: string })
          .operation === "authorize"
      )
        f.advance(TRANSFER_LIFETIME_MS);
    };
    await expect(f.target.service.import(first.url)).rejects.toThrow("expired");
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(0);
    f.transport.after = undefined;
    const second = await f.source.service.send({ tabId: published.tab.id, peerId });
    await f.target.service.inspect(second.url);
    invitation = readTransferUrl(second.url);
    f.transport.after = async (_address, body) => {
      if (
        (decryptTransfer(secret, invitation, "request", body).value as { operation: string })
          .operation === "ack"
      )
        throw new Error("Synthetic lost acknowledgement");
    };
    const imported = await f.target.service.import(second.url);
    expect(await f.target.service.import(second.url)).toEqual({
      ...imported,
      alreadyImported: true,
    });
    expect((await f.target.lifecycle.workspace()).tabs).toHaveLength(1);
  } finally {
    await f.close();
  }
});
