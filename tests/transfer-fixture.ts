import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { TabTransfers } from "../apps/desktop/src/transfer/service.ts";
import { readTransferUrl } from "@irudd-scope/protocol/transfer";
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

export async function transferFixture() {
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
