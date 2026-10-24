import { createHash } from "node:crypto";
import { once } from "node:events";
import { Schema } from "effect";
import { decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import {
  GUEST_CATALOG_BYTES,
  GuestCatalog,
  GuestCatalogRequest,
  GuestContentRequest,
  type GuestSource,
} from "@irudd-scope/protocol/guest";
import type { ArtifactStore } from "../library/store.ts";
import type { DesktopStore } from "../desktop-store.ts";
import type { ArtifactContent } from "../bridge.ts";
import type { GuestCatalogView } from "./contract.ts";
import type { GuestConnections, GuestOwnerRequest } from "./service.ts";

async function bytes(stream: AsyncIterable<Uint8Array>, limit: number) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw new Error("Guest response exceeds its limit.");
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts, size);
}
async function input<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  request: GuestOwnerRequest["request"],
): Promise<S["Type"]> {
  return decode(schema, JSON.parse((await bytes(request, 1024)).toString()));
}

function guestFailure(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^(Update (Scope|the other Scope)|The owner |This source |Guest catalog owner )/.test(
    message,
  )
    ? message
    : fallback;
}

/** Catalog ownership and artifact reads. Connections owns authentication and cancellation. */
export class GuestCatalogs {
  private closed = new AbortController();
  private changes = new Set<() => void>();
  private reads = new Map<AbortController, { sourceTabId: string; revision: number }>();
  private generation = 0;
  private ownerQueue = Promise.resolve();
  private polls = new Map<string, Promise<void>>();
  private view: GuestCatalogView = { records: [], owners: [], available: [] };
  private available = new Map<string, { sources: Set<string>; access: AbortSignal }>();
  private owners = new Map<string, GuestCatalogView["owners"][number]>();
  private remove: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private viewGeneration = 0;

  constructor(
    private readonly connections: GuestConnections,
    private readonly desktop: DesktopStore,
    private readonly artifacts: ArtifactStore,
    private readonly changed: (view: GuestCatalogView) => void,
  ) {
    this.remove.push(
      artifacts.subscribe(() => {
        this.generation++;
        for (const [read, expected] of this.reads) {
          void this.resolveSource(expected.sourceTabId).then(
            (source) => {
              if (source.artifact?.revision !== expected.revision) read.abort();
            },
            () => read.abort(),
          );
        }
        for (const listener of this.changes) listener();
      }),
    );
    this.remove.push(
      connections.register("catalog", {
        capability: "catalog-v1",
        method: "POST",
        idleMs: 25000,
        deadlineMs: 30000,
        handle: (request) => this.serveCatalog(request),
      }),
    );
    for (const [route, capability, kind] of [
      ["artifact-content", "artifact-read-v1", "file"],
      ["plan-content", "plan-read-v1", "plan"],
    ] as const)
      this.remove.push(
        connections.register(route, {
          capability,
          method: "POST",
          idleMs: 15000,
          deadlineMs: 60000,
          handle: (request) => this.serveContent(request, kind),
        }),
      );
  }

  async start() {
    await this.publish();
    void this.tick();
  }
  snapshot() {
    return this.view;
  }
  private async publish() {
    const generation = ++this.viewGeneration;
    const records = await this.desktop.guestRecords();
    const peers = await this.desktop.scopePeers();
    for (const owner of this.available.keys()) {
      const peer = peers.find((peer) => peer.deviceId === owner);
      try {
        if (!peer) throw new Error("Owner forgotten.");
        const access = this.connections.access(peer.id);
        if (this.available.get(owner)?.access !== access) this.available.delete(owner);
      } catch {
        this.available.delete(owner);
      }
    }
    if (this.closed.signal.aborted || generation !== this.viewGeneration) return;
    const view: GuestCatalogView = {
      records,
      owners: [...this.owners.values()],
      available: records
        .filter((record) =>
          this.available.get(record.ownerDeviceId)?.sources.has(record.source.sourceTabId),
        )
        .map((record) => record.tab.id),
    };
    if (JSON.stringify(view) === JSON.stringify(this.view)) return;
    this.view = view;
    this.changed(this.view);
  }

  /** Serializes snapshot capture and revision allocation, including concurrent peers. */
  private ownerCatalog(): Promise<GuestCatalog> {
    const result = this.ownerQueue.then(async () => {
      while (true) {
        this.closed.signal.throwIfAborted();
        const generation = this.generation;
        const sources = await this.artifacts.guestSources();
        const ownerDeviceId = (await this.desktop.transferDevice()).deviceId;
        const revision = await this.desktop.guestCatalogRevision(sources);
        if (generation !== this.generation) continue;
        const catalog = decode(GuestCatalog, { version: 1, ownerDeviceId, revision, sources });
        if (Buffer.byteLength(JSON.stringify(catalog)) > GUEST_CATALOG_BYTES)
          throw new Error("The shared catalog is too large to refresh.");
        return catalog;
      }
    });
    this.ownerQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async serveCatalog({ request, response, signal, peer }: GuestOwnerRequest) {
    const { after } = await input(GuestCatalogRequest, request);
    // One pending catalog per paired device; bounded by the connection's own request limit.
    if (this.waiting.has(peer.id)) throw new Error("A catalog request is already active.");
    this.waiting.add(peer.id);
    let wake!: () => void;
    const change = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const timer = setTimeout(() => wake(), 20000);
    this.changes.add(wake);
    signal.addEventListener("abort", wake, { once: true });
    try {
      let catalog = await this.ownerCatalog();
      if (after === catalog.revision) {
        await change;
        signal.throwIfAborted();
        catalog = await this.ownerCatalog();
      }
      signal.throwIfAborted();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(catalog));
    } finally {
      clearTimeout(timer);
      this.waiting.delete(peer.id);
      this.changes.delete(wake);
      signal.removeEventListener("abort", wake);
    }
  }
  private waiting = new Set<string>();

  /** Owner operations resolve here instead of accepting a supplied artifact ID or root. */
  async resolveSource(sourceTabId: string): Promise<GuestSource> {
    const source = (await this.artifacts.guestSources()).find(
      (source) => source.sourceTabId === sourceTabId,
    );
    if (!source)
      throw new Error(
        "This source tab is no longer shared. It may have moved to Trashcan or been deleted.",
      );
    return source;
  }

  private async serveContent(
    { request, response, signal }: GuestOwnerRequest,
    kind: "file" | "plan",
  ) {
    const { sourceTabId, revision } = await input(GuestContentRequest, request);
    const active = new AbortController();
    const access = AbortSignal.any([signal, active.signal]);
    const abort = () => response.destroy();
    this.reads.set(active, { sourceTabId, revision });
    access.addEventListener("abort", abort, { once: true });
    try {
      const source = await this.resolveSource(sourceTabId);
      const artifact = source.artifact;
      if (source.kind !== kind || !artifact || artifact.revision !== revision)
        throw new Error("This source changed. Refresh the guest tab.");
      const content = await this.artifacts.content(artifact.blob);
      const current = await this.resolveSource(sourceTabId);
      access.throwIfAborted();
      if (current.artifact?.revision !== revision || current.artifact.blob !== artifact.blob)
        throw new Error("This source changed. Refresh the guest tab.");
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": content.length,
      });
      for (let offset = 0; offset < content.length; offset += 64 * 1024) {
        access.throwIfAborted();
        if (!response.write(content.subarray(offset, offset + 64 * 1024)))
          await once(response, "drain", { signal: access });
      }
      response.end();
      if (!response.writableFinished) await once(response, "finish", { signal: access });
    } finally {
      this.reads.delete(active);
      access.removeEventListener("abort", abort);
    }
  }

  private async tick() {
    if (this.ticking || this.closed.signal.aborted) return;
    this.ticking = true;
    try {
      const peers = await this.desktop.scopePeers();
      const status = await this.connections.status();
      for (const peer of peers) {
        const state = status.peers.find((state) => state.peerId === peer.id);
        if (state?.state === "connected") {
          if (!this.polls.has(peer.id)) {
            const poll = this.poll(peer.id, peer.deviceId, peer.name).finally(() =>
              this.polls.delete(peer.id),
            );
            this.polls.set(peer.id, poll);
          }
        } else {
          this.available.delete(peer.deviceId);
          this.owners.set(peer.deviceId, {
            deviceId: peer.deviceId,
            name: peer.name,
            state: state?.state ?? "offline",
            message:
              state?.state === "disabled"
                ? `Guest sharing with ${peer.name} is off on this Scope. Enable it in Other Scopes to reconnect.`
                : state?.state === "setup"
                  ? `Connect a guest connection link for ${peer.name} in Other Scopes.`
                  : state?.state === "update-required" || state?.state === "access-denied"
                    ? state.message
                    : `${peer.name} is unavailable. Open that Scope and check its connection. Scope will reconnect automatically; you can also retry in Other Scopes.`,
          });
        }
      }
      for (const record of await this.desktop.guestRecords())
        if (!peers.some((peer) => peer.deviceId === record.ownerDeviceId)) {
          const id = record.ownerDeviceId;
          this.available.delete(id);
          this.owners.set(id, {
            deviceId: id,
            name: this.owners.get(id)?.name ?? "The owner",
            state: "forgotten",
            message:
              "This owner is no longer paired. Pair it again and enable guest sharing in Other Scopes. Your local tab position is saved.",
          });
        }
      await this.publish();
    } catch {
      console.error("Could not refresh guest catalog status.");
    } finally {
      this.ticking = false;
      if (!this.closed.signal.aborted)
        this.timer = setTimeout(() => {
          void this.tick();
        }, 1000);
    }
  }

  private async poll(peerId: string, ownerDeviceId: string, name: string) {
    let after: number | undefined;
    try {
      while (!this.closed.signal.aborted) {
        const access = this.connections.access(peerId);
        const response = await this.connections.request(peerId, "catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(after === undefined ? {} : { after })),
          signal: this.closed.signal,
          deadlineMs: 30000,
          idleMs: 25000,
        });
        let catalog: GuestCatalog;
        try {
          if (response.status !== 200)
            throw new Error("The owner catalog is unavailable. Retry the connection.");
          const data = JSON.parse((await bytes(response.body, GUEST_CATALOG_BYTES)).toString());
          try {
            catalog = decode(GuestCatalog, data);
          } catch {
            throw new Error("Update Scope to read this owner's catalog version or tab types.");
          }
        } finally {
          response.body.destroy();
        }
        if (catalog.ownerDeviceId !== ownerDeviceId)
          throw new Error("Guest catalog owner does not match this paired Scope.");
        for (const source of catalog.sources) {
          if (
            source.version !== 1 ||
            (source.kind === "file" &&
              (!source.artifact ||
                !["html", "markdown", "text", "image", "file", "excalidraw"].includes(
                  source.artifact.kind,
                ))) ||
            (source.kind === "plan" && source.artifact?.kind !== "plan") ||
            (source.kind === "folder" && source.artifact)
          )
            throw new Error("Update Scope to open this owner's shared tab types.");
        }
        access.throwIfAborted();
        if (!(await this.desktop.applyGuestCatalog(catalog)))
          throw new Error("The owner returned an older catalog. Retry the connection.");
        this.closed.signal.throwIfAborted();
        access.throwIfAborted();
        after = catalog.revision;
        this.available.set(ownerDeviceId, {
          sources: new Set(catalog.sources.map((source) => source.sourceTabId)),
          access,
        });
        this.owners.set(ownerDeviceId, { deviceId: ownerDeviceId, name, state: "connected" });
        await this.publish();
      }
    } catch (error) {
      this.available.delete(ownerDeviceId);
      const message = guestFailure(
        error,
        `${name} is unavailable. Reconnect to read current content.`,
      );
      this.owners.set(ownerDeviceId, {
        deviceId: ownerDeviceId,
        name,
        state: /update/i.test(message) ? "update-required" : "offline",
        message,
      });
      await this.publish();
    }
  }

  async content(id: string, revision: number): Promise<ArtifactContent> {
    const record = (await this.desktop.guestRecords()).find((record) => record.tab.id === id);
    if (!record || !this.view.available.includes(id))
      throw new Error("The owner or source tab is unavailable. Reconnect to read current content.");
    const artifact = record.source.artifact;
    if (!artifact || record.source.kind === "folder" || record.source.version !== 1)
      throw new Error("Update Scope to open this guest tab type.");
    if (artifact.revision !== revision)
      throw new Error("This source changed. Refresh the guest tab.");
    const peer = (await this.desktop.scopePeers()).find(
      (peer) => peer.deviceId === record.ownerDeviceId,
    );
    if (!peer) throw new Error("The owner is no longer paired.");
    const access = this.connections.access(peer.id);
    if (this.available.get(record.ownerDeviceId)?.access !== access)
      throw new Error("The owner catalog is refreshing. Try again shortly.");
    const response = await this.connections
      .request(peer.id, record.source.kind === "plan" ? "plan-content" : "artifact-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ sourceTabId: record.source.sourceTabId, revision })),
        signal: this.closed.signal,
        idleMs: 15000,
        deadlineMs: 60000,
      })
      .catch((error) => {
        throw new Error(
          guestFailure(error, "Could not read current content from the owner. Try again."),
        );
      });
    try {
      if (response.status !== 200)
        throw new Error("The owner no longer allows this read. Refresh the guest tab.");
      const content = await bytes(response.body, MAX_CONTENT_BYTES);
      if (
        content.length !== artifact.size ||
        createHash("sha256").update(content).digest("hex") !== artifact.blob
      )
        throw new Error("The owner content did not match the requested revision.");
      access.throwIfAborted();
      const latest = this.view.records.find((record) => record.tab.id === id);
      if (!this.view.available.includes(id) || latest?.source.artifact?.revision !== revision)
        throw new Error("This source changed while reading. Refresh the guest tab.");
      return { artifact, bytes: content };
    } catch (error) {
      throw new Error(
        guestFailure(error, "Could not read current content from the owner. Try again."),
      );
    } finally {
      response.body.destroy();
    }
  }

  async close() {
    this.closed.abort();
    clearTimeout(this.timer);
    for (const read of this.reads.keys()) read.abort();
    for (const wake of this.changes) wake();
    for (const remove of this.remove) remove();
    await Promise.allSettled([...this.polls.values(), this.ownerQueue]);
  }
}
