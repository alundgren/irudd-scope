import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { GuestSource } from "@irudd-scope/protocol/guest";
import {
  GUEST_OPERATION_CAPABILITY,
  MAX_GUEST_OPERATION_BYTES,
  GuestChange,
  GuestOperation,
  GuestOperationIdentity,
  GuestOutcome,
  GuestTarget,
  GuestRead,
} from "@irudd-scope/protocol/guest-operation";
import type { DesktopStore } from "../desktop-store.ts";
import type { ArtifactStore } from "../library/store.ts";
import type { DesktopLifecycle } from "../lifecycle.ts";
import type { GuestConnections, GuestOwnerRequest } from "./service.ts";
import type { GuestCatalogs } from "./catalog.ts";

async function bytes(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_GUEST_OPERATION_BYTES)
      throw new Error("Guest operation exceeds its input limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
export class GuestMutations {
  private remove: (() => void)[] = [];
  private closed = new AbortController();
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly connections: GuestConnections,
    private readonly desktop: DesktopStore,
    private readonly artifacts: ArtifactStore,
    private readonly catalogs: GuestCatalogs,
    private readonly lifecycle: DesktopLifecycle,
  ) {
    for (const route of ["prepare", "execute", "status", "source"])
      this.remove.push(
        connections.register(`mutation-${route}`, {
          capability: GUEST_OPERATION_CAPABILITY,
          method: "POST",
          idleMs: 15000,
          deadlineMs: 60000,
          handle: (request) => this.serve(route, request),
        }),
      );
  }
  private async serve(route: string, { request, response, peer, signal }: GuestOwnerRequest) {
    const input = JSON.parse((await bytes(request)).toString());
    const ownerId = (await this.desktop.guestDevice()).deviceId;
    let result: unknown;
    if (route === "status")
      result = await this.artifacts.guestOperations.status(
        peer.deviceId,
        decode(GuestOperationIdentity, input),
        signal,
      );
    else if (route === "source") {
      const target = decode(GuestTarget, input);
      if (target.ownerDeviceId !== ownerId) throw new Error("Wrong owner device.");
      result =
        (await this.artifacts.guestSources()).find(
          (source) => source.sourceTabId === target.sourceTabId,
        ) ?? null;
    } else {
      const change =
        route === "prepare" ? decode(GuestChange, input) : decode(GuestOperation, input).change;
      if (change.target.ownerDeviceId !== ownerId) throw new Error("Wrong owner device.");
      result =
        route === "prepare"
          ? await this.artifacts.guestOperations.prepare(peer.deviceId, change, signal)
          : await this.artifacts.guestOperations.execute(
              peer.deviceId,
              decode(GuestOperation, input),
              signal,
            );
      if (route === "execute" && (result as GuestOutcome).state === "completed")
        await this.lifecycle.guestSourceChanged(change.target.sourceTabId);
    }
    signal.throwIfAborted();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  }
  private async peer(target: GuestTarget) {
    const peer = (await this.desktop.guestPeers()).find(
      (peer) => peer.deviceId === target.ownerDeviceId,
    );
    if (!peer) throw new Error("The owner is no longer paired.");
    this.connections.access(peer.id);
    return peer.id;
  }
  private async call(target: GuestTarget, route: string, input: unknown) {
    const peer = await this.peer(target);
    const response = await this.connections.request(peer, `mutation-${route}`, {
      method: "POST",
      body: Buffer.from(JSON.stringify(input)),
      headers: { "Content-Type": "application/json" },
      signal: this.closed.signal,
      idleMs: 15000,
      deadlineMs: 60000,
    });
    try {
      const data = JSON.parse((await bytes(response.body)).toString());
      if (response.status !== 200)
        throw new Error(typeof data.error === "string" ? data.error : "Owner operation failed.");
      return data;
    } finally {
      response.body.destroy();
    }
  }
  private async record(target: GuestTarget) {
    const record = (await this.desktop.guestRecords()).find(
      (record) =>
        record.ownerDeviceId === target.ownerDeviceId &&
        record.source.sourceTabId === target.sourceTabId,
    );
    if (!record) throw new Error("No guest for this owner and source.");
    return record;
  }
  private serial<A>(id: string, work: () => Promise<A>): Promise<A> {
    const task = (this.pending.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    this.pending.set(id, task);
    void task
      .finally(() => {
        if (this.pending.get(id) === task) this.pending.delete(id);
      })
      .catch(() => {});
    return task;
  }
  async prepare(input: GuestChange) {
    const change = decode(GuestChange, input);
    const record = await this.record(change.target);
    return this.serial(record.tab.id, async () => {
      if (
        (await this.desktop.guestRecovery.read(record.tab.id)).pending ||
        (await this.desktop.guestRecovery.folderRead(record.tab.id))
      )
        throw new Error("Resolve the previous operation before making another source change.");
      const outcome = decode(GuestOutcome, await this.call(change.target, "prepare", change));
      if (outcome.state !== "prepared") throw new Error("Owner did not prepare the operation.");
      const operation = decode(GuestOperation, {
        operationId: outcome.operationId,
        digest: outcome.digest,
        change,
      });
      await this.desktop.guestRecovery.pending({
        guestId: record.tab.id,
        operation,
        outcome,
        dispatched: false,
      });
      return operation;
    });
  }
  async execute(target: GuestTarget, identity: GuestOperationIdentity) {
    const record = await this.record(target);
    return this.serial(record.tab.id, async () => {
      const pending = await this.saved(record.tab.id, identity);
      if (pending.dispatched)
        throw new Error("This operation was dispatched. Check its status; do not replay it.");
      // This durable write must succeed before any source-changing network request.
      await this.desktop.guestRecovery.pending({ ...pending, dispatched: true });
      try {
        const outcome = decode(GuestOutcome, await this.call(target, "execute", pending.operation));
        await this.desktop.guestRecovery.pending({ ...pending, dispatched: true, outcome });
        return outcome;
      } catch {
        throw new Error(
          "The source outcome is uncertain. Input and operation identity are saved. Check status before making another change.",
        );
      }
    });
  }
  private async saved(id: string, identity: GuestOperationIdentity) {
    const pending = (await this.desktop.guestRecovery.read(id)).pending;
    if (
      !pending ||
      pending.operation.operationId !== identity.operationId ||
      pending.operation.digest !== identity.digest
    )
      throw new Error("No matching saved operation.");
    return pending;
  }
  async status(target: GuestTarget, identity: GuestOperationIdentity) {
    const record = await this.record(target);
    return this.serial(record.tab.id, async () => {
      const pending = await this.saved(record.tab.id, identity);
      const outcome = decode(GuestOutcome, await this.call(target, "status", identity));
      await this.desktop.guestRecovery.pending({ ...pending, dispatched: true, outcome });
      return outcome;
    });
  }
  async reconcile(target: GuestTarget, identity: GuestOperationIdentity) {
    const record = await this.record(target);
    return this.serial(record.tab.id, async () => {
      const pending = await this.saved(record.tab.id, identity);
      // Settle a prepared write first, even if a response to execute was dropped.
      const outcome = decode(GuestOutcome, await this.call(target, "status", identity));
      await this.desktop.guestRecovery.pending({ ...pending, dispatched: true, outcome });
      const source = decode(Schema.NullOr(GuestSource), await this.call(target, "source", target));
      await this.desktop.guestRecovery.discard(record.tab.id, "operation", 0);
      return { outcome, source };
    });
  }
  async read(input: GuestRead) {
    const read = decode(GuestRead, input);
    const record = await this.record(read.target);
    const content = await this.catalogs.content(record.tab.id, read.revision);
    return { artifact: content.artifact, content: Buffer.from(content.bytes).toString("utf8") };
  }
  async command(route: string, input: unknown): Promise<unknown> {
    if (route === "prepare") return this.prepare(decode(GuestChange, input));
    if (route === "read") return this.read(decode(GuestRead, input));
    if (route === "pending") {
      const record = await this.record(decode(GuestTarget, input));
      const pending = (await this.desktop.guestRecovery.read(record.tab.id)).pending;
      return pending
        ? {
            artifactId: record.source.artifact?.id,
            operation: pending.operation,
            outcome: pending.outcome,
            dispatched: pending.dispatched,
          }
        : null;
    }
    if (route === "source") {
      const target = decode(GuestTarget, input);
      await this.record(target);
      return decode(Schema.NullOr(GuestSource), await this.call(target, "source", target));
    }
    const { target, ...identity } = decode(
      Schema.Struct({ target: GuestTarget, ...GuestOperationIdentity.fields }),
      input,
    );
    if (route === "execute") return this.execute(target, identity);
    if (route === "status") return this.status(target, identity);
    if (route === "reconcile") return this.reconcile(target, identity);
    throw new Error("Unsupported guest operation.");
  }
  async close() {
    this.closed.abort();
    for (const remove of this.remove) remove();
    await Promise.allSettled(this.pending.values());
  }
}
