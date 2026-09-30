import {
  Artifact,
  ArtifactWrite,
  BlobReceipt,
  PublicationReceipt,
  ScopeError,
  decode,
} from "@irudd-scope/protocol";
import type { PublicationQueue, BufferedTab } from "./publication-queue.ts";

export type RelayCall = (
  method: "GET" | "POST" | "PUT",
  path: string,
  body: Buffer,
  signal: AbortSignal,
) => Promise<unknown>;

export class PublicationDelivery {
  private running?: Promise<void>;
  private current?: { id: string; controller: AbortController };
  private closed = false;
  constructor(
    private readonly queue: PublicationQueue,
    private readonly relay: RelayCall,
    private readonly connected: () => boolean,
  ) {}

  start() {
    if (this.closed || this.running || !this.connected()) return;
    this.running = this.drain()
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
      });
  }
  cancel(id?: string) {
    if (!id || this.current?.id === id) this.current?.controller.abort();
  }
  async close() {
    this.closed = true;
    this.cancel();
    await this.running;
  }
  private async drain() {
    while (!this.closed && this.connected()) {
      const item = this.queue.next();
      if (!item) return;
      const controller = new AbortController();
      this.current = { id: item.id, controller };
      try {
        await this.deliver(item, controller.signal);
        this.queue.remove(item.id, item.tabId);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (
          error instanceof ScopeError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        ) {
          this.queue.block(item.id, item.tabId, error.message);
        } else return;
      } finally {
        this.current = undefined;
      }
    }
  }
  private async deliver(item: BufferedTab, signal: AbortSignal) {
    const input = decode(ArtifactWrite, JSON.parse(item.document!));
    const path = `/v1/artifacts/${item.id}`;
    let current: Artifact | undefined;
    try {
      current = decode(Artifact, await this.relay("GET", path, Buffer.alloc(0), signal));
    } catch (error) {
      if (!(error instanceof ScopeError) || error.status !== 404) throw error;
    }
    if (
      item.writing &&
      current &&
      current.revision > input.expectedRevision &&
      this.matches(current, input)
    )
      return;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new ScopeError(
        409,
        "The desktop artifact changed while this publication was buffered. Discard it and publish against the current revision.",
      );
    const { tabId } = decode(
      PublicationReceipt,
      await this.relay(
        "POST",
        `${path}/tab`,
        Buffer.from(JSON.stringify({ expectedRevision: input.expectedRevision })),
        signal,
      ),
    );
    const { blob } = decode(
      BlobReceipt,
      await this.relay("POST", `/v1/tabs/${tabId}/blobs`, this.queue.content(item.id), signal),
    );
    if (blob !== input.blob) throw new Error("The desktop returned a different content digest.");
    if (signal.aborted) throw signal.reason;
    const pending = this.queue.get(item.id);
    if (!pending || pending.tabId !== item.tabId)
      throw new ScopeError(404, "The buffered publication expired or was discarded.");
    this.queue.markWriting(item.id);
    decode(
      Artifact,
      await this.relay("PUT", path, Buffer.from(JSON.stringify({ ...input, tabId })), signal),
    );
  }
  private matches(current: Artifact, input: ArtifactWrite) {
    const { expectedRevision: _revision, tabId: _tabId, ...metadata } = input;
    return Object.entries(metadata).every(
      ([key, value]) => JSON.stringify(current[key as keyof Artifact]) === JSON.stringify(value),
    );
  }
}
