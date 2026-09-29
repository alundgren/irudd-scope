import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { decode } from "@irudd-scope/protocol";
import {
  Share,
  SharingPairReceipt,
  SharingStatus,
  SHARE_LIFETIME_MS,
  readSharingPairUrl,
  sharingEndpoint,
  sharingJson,
  SharingRequestError,
  type ShareWrite,
} from "@irudd-scope/protocol/sharing";
import type { DesktopStore } from "./desktop-store.ts";
import { activeShare, type SharingDestination, type SharingView } from "./sharing-contract.ts";

export type SharedSnapshot = Pick<ShareWrite, "tabId" | "title" | "mediaType" | "content">;
class SharingUnavailable extends Error {}

export class Sharing {
  private readonly entries = new Map<string, SharingView>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private pairing?: Promise<void>;
  constructor(
    private readonly store: DesktopStore,
    private readonly changed: (views: SharingView[]) => void,
  ) {}
  snapshot() {
    return [...this.entries.values()].map((value) => structuredClone(value));
  }
  async start() {
    for (const entry of await this.store.sharingDestinations())
      this.entries.set(entry.id, { ...entry, connected: false });
    const poll = () => {
      for (const id of this.entries.keys())
        if (!this.pending.has(id)) void this.run(id, () => this.sync(id)).catch(() => {});
    };
    this.timer = setInterval(poll, 5000);
    this.timer.unref();
    poll();
  }
  private async save(entry: SharingDestination) {
    await this.store.saveSharing(entry);
    this.entries.set(entry.id, {
      ...this.entries.get(entry.id),
      ...entry,
      connected: this.entries.get(entry.id)?.connected ?? false,
    });
    this.changed(this.snapshot());
  }
  private entry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Pair this sharing service in Settings first.");
    return entry;
  }
  private run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        this.abort.signal.throwIfAborted();
        try {
          return await action();
        } catch (error) {
          const entry = this.entries.get(id);
          if (entry) {
            this.entries.set(id, {
              ...entry,
              connected: error instanceof SharingUnavailable ? false : entry.connected,
              message:
                error instanceof Error ? error.message : "The sharing service is unavailable.",
            });
            this.changed(this.snapshot());
          }
          throw error;
        }
      });
    this.pending.set(id, task);
    void task.then(
      () => {
        if (this.pending.get(id) === task) this.pending.delete(id);
      },
      () => {
        if (this.pending.get(id) === task) this.pending.delete(id);
      },
    );
    return task;
  }
  private async request(entry: SharingDestination, path: string, method = "GET", body?: unknown) {
    const token = await this.store.sharingToken(entry.id);
    if (!token)
      throw new SharingUnavailable(
        "The pairing credential is unavailable. Restore Keychain access or unpair the service using its CLI.",
      );
    const response = await fetch(`${sharingEndpoint(entry.endpoint)}${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.any([
        this.abort.signal,
        AbortSignal.timeout(body === undefined ? 8000 : 65_000),
      ]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw new SharingUnavailable(
        "The sharing service is unreachable. Check its host and connection, then retry.",
      );
    });
    try {
      return await sharingJson(response);
    } catch (error) {
      if (error instanceof SharingRequestError && error.status !== 401 && error.status !== 403)
        throw error;
      throw new SharingUnavailable(
        error instanceof SharingRequestError
          ? error.message
          : "The sharing service returned an invalid response.",
      );
    }
  }
  pair(value: string) {
    this.abort.signal.throwIfAborted();
    if (this.pairing) throw new Error("A sharing service is already being paired.");
    const task = this.pairService(value);
    this.pairing = task;
    const completed = () => {
      this.pairing = undefined;
    };
    void task.then(completed, completed);
    return task;
  }
  private async pairService(value: string) {
    const { endpoint, token } = readSharingPairUrl(value);
    if (this.entries.size >= 32)
      throw new Error("Remove a sharing service before pairing another.");
    if ([...this.entries.values()].some((entry) => entry.endpoint === endpoint))
      throw new Error("This sharing service is already paired.");
    const receipt = decode(
      SharingPairReceipt,
      await sharingJson(
        await fetch(`${endpoint}/v1/pair`, {
          method: "POST",
          redirect: "error",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: hostname() }),
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
        }),
      ),
    );
    const entry: SharingView = {
      id: receipt.id,
      name: receipt.name,
      endpoint,
      shares: [],
      pendingStops: [],
      removing: false,
      connected: true,
    };
    try {
      if (this.entries.has(receipt.id))
        throw new Error(
          "A service with this identity is already paired. Its existing shares and pending stops were retained.",
        );
      await this.store.saveSharing(entry, receipt.token);
    } catch (error) {
      await fetch(`${endpoint}/v1/pair`, {
        method: "DELETE",
        redirect: "error",
        headers: { Authorization: `Bearer ${receipt.token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      throw error;
    }
    this.entries.set(entry.id, entry);
    this.changed(this.snapshot());
  }
  private async sync(id: string) {
    let entry = this.entry(id);
    if (entry.removing) {
      await this.request(entry, "/v1/pair", "DELETE");
      await this.store.removeSharing(id);
      this.entries.delete(id);
      this.changed(this.snapshot());
      return;
    }
    for (const shareId of entry.pendingStops) {
      await this.request(entry, `/v1/shares/${shareId}`, "DELETE");
      entry = {
        ...entry,
        pendingStops: entry.pendingStops.filter((value) => value !== shareId),
        shares: entry.shares.map((share) =>
          share.id === shareId ? { ...share, status: "stopped" as const } : share,
        ),
      };
      await this.save(entry);
    }
    const status = decode(SharingStatus, await this.request(entry, "/v1/shares"));
    if (status.id !== id)
      throw new SharingUnavailable("The sharing service identity changed. Check its installation.");
    const missing = entry.shares.filter(
      (share) => activeShare(share) && !status.shares.some((current) => current.id === share.id),
    );
    entry = { ...entry, name: status.name, shares: [...missing, ...status.shares].slice(0, 128) };
    await this.save(entry);
    this.entries.set(id, { ...entry, connected: true, message: undefined });
    this.changed(this.snapshot());
  }
  refreshStatus(id: string) {
    return this.run(id, () => this.sync(id));
  }
  stop(id: string, shareId: string) {
    return this.run(id, async () => {
      const entry = this.entry(id);
      if (!entry.shares.some((share) => share.id === shareId))
        throw new Error("This share is not recorded on this desktop.");
      await this.save({ ...entry, pendingStops: [...new Set([...entry.pendingStops, shareId])] });
      await this.sync(id);
    });
  }
  remove(id: string) {
    return this.run(id, async () => {
      await this.save({ ...this.entry(id), removing: true });
      await this.sync(id);
    });
  }
  write(id: string, snapshot: SharedSnapshot, refreshId?: string) {
    return this.run(id, async () => {
      const entry = this.entry(id);
      if (entry.removing || entry.pendingStops.length)
        throw new Error("Wait for the pending stops to finish before sharing content.");
      const previous = entry.shares.find(
        (share) => share.tabId === snapshot.tabId && activeShare(share),
      );
      if (previous && refreshId !== previous.id) return previous;
      if (refreshId && (!previous || previous.id !== refreshId || previous.status !== "active"))
        throw new Error("This share has ended. Reopen Share from the tab.");
      const shareId = previous?.id ?? randomUUID();
      const operationId = randomUUID();
      if (!previous) {
        if (entry.shares.filter(activeShare).length >= 5)
          throw new Error(
            "Stop a share before creating another. This service allows five active shares.",
          );
        const now = Date.now();
        await this.save({
          ...entry,
          shares: [
            {
              id: shareId,
              tabId: snapshot.tabId,
              operationId,
              title: snapshot.title,
              revision: 1,
              createdAt: now,
              updatedAt: now,
              expiresAt: now + SHARE_LIFETIME_MS,
              status: "starting" as const,
              url: null,
            },
            ...entry.shares,
          ].slice(0, 128),
        });
      }
      try {
        const result = decode(
          Share,
          await this.request(entry, `/v1/shares/${shareId}`, "PUT", {
            ...snapshot,
            operationId,
            expectedRevision: previous?.revision ?? null,
          } satisfies ShareWrite),
        );
        if (result.id !== shareId || result.tabId !== snapshot.tabId)
          throw new Error("The sharing service returned a different share.");
        const current = this.entry(id);
        await this.save({
          ...current,
          shares: [result, ...current.shares.filter((share) => share.id !== shareId)],
        });
        this.entries.set(id, { ...this.entry(id), connected: true, message: undefined });
        this.changed(this.snapshot());
        return result;
      } catch (error) {
        const reconciled = await this.sync(id).then(
          () => true,
          () => false,
        );
        const confirmed = this.entry(id).shares.find(
          (share) =>
            share.id === shareId && share.operationId === operationId && share.status === "active",
        );
        if (reconciled && confirmed) return confirmed;
        if (reconciled && error instanceof SharingUnavailable) throw new Error(error.message);
        throw error;
      }
    });
  }
  async close() {
    clearInterval(this.timer);
    this.abort.abort();
    await Promise.allSettled([...this.pending.values(), this.pairing]);
  }
}
