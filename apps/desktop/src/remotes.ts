import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { decode, validateEndpoint } from "@irudd-scope/protocol";
import {
  artifactRequest,
  PairReceipt,
  readPairingUrl,
  readRemoteJson,
  readRelayEvents,
  type RelayRequest,
} from "@irudd-scope/protocol/remote";
import type { DesktopStore } from "./desktop-store.ts";
import type { Remote, RemoteStatus } from "./remote-contract.ts";

type Connection = { controller: AbortController; task: Promise<void> };

export class Remotes {
  private readonly statuses = new Map<string, RemoteStatus>();
  private readonly connections = new Map<string, Connection>();
  private readonly pairing = new AbortController();
  private pending = Promise.resolve();
  private closed = false;

  constructor(
    private readonly store: DesktopStore,
    private readonly local: { url: string; token: string },
    private readonly onChange: (status: RemoteStatus[]) => void,
  ) {}

  snapshot() {
    return [...this.statuses.values()];
  }
  private status(remote: Remote, connection: RemoteStatus["connection"], message: string) {
    this.statuses.set(remote.id, { ...remote, connection, message });
    this.onChange(this.snapshot());
  }
  async start() {
    for (const remote of await this.store.remotes()) {
      this.status(remote, "disconnected", "Disconnected.");
      if (remote.enabled) this.connect(remote);
    }
  }
  private change(action: () => Promise<void>) {
    if (this.closed) return Promise.reject(new Error("Scope is closing."));
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }
  pair(value: string) {
    return this.change(() => this.performPair(value));
  }
  private async performPair(value: string) {
    const { endpoint, token } = readPairingUrl(value);
    const response = await fetch(`${endpoint}/v1/pair`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: hostname().slice(0, 160) }),
      signal: AbortSignal.any([this.pairing.signal, AbortSignal.timeout(10_000)]),
    }).catch(() => {
      throw new Error(
        "Could not reach the hub. Check that both machines are on the tailnet and the hub is running.",
      );
    });
    if (!response.ok)
      throw new Error("Pairing failed. Run irudd-scope pair on the remote for a fresh link.");
    const receipt = await readRemoteJson(response)
      .then((value) => decode(PairReceipt, value))
      .catch(() => {
        throw new Error(
          "The hub returned an invalid pairing receipt. Generate a new pairing on the remote and retry.",
        );
      });
    if (this.statuses.has(receipt.id)) await this.disconnect(receipt.id);
    const remote: Remote = { id: receipt.id, name: receipt.name, endpoint, enabled: true };
    try {
      await this.store.saveRemote(remote, receipt.token);
    } catch {
      await fetch(`${endpoint}/v1/relay/disconnect`, {
        method: "DELETE",
        redirect: "error",
        headers: { Authorization: `Bearer ${receipt.token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      throw new Error(
        "Could not save the pairing credential. Check Keychain access, then generate a new pairing link on the remote.",
      );
    }
    this.connect(remote);
  }
  setEnabled(id: string, enabled: boolean) {
    return this.change(() => this.changeEnabled(id, enabled));
  }
  private async changeEnabled(id: string, enabled: boolean) {
    const previous = this.statuses.get(id);
    if (!previous) throw new Error("Remote not found.");
    const remote: Remote = {
      id: previous.id,
      name: previous.name,
      endpoint: previous.endpoint,
      enabled,
    };
    await this.store.saveRemote(remote);
    await this.disconnect(id);
    this.status(remote, "disconnected", "Disconnected.");
    if (enabled) this.connect(remote);
  }
  remove(id: string) {
    return this.change(() => this.removeSaved(id));
  }
  private async removeSaved(id: string) {
    const remote = this.statuses.get(id);
    if (!remote) return;
    await this.changeEnabled(id, false);
    const token = await this.store.remoteToken(id);
    if (token) {
      const response = await fetch(`${validateEndpoint(remote.endpoint)}/v1/relay/disconnect`, {
        method: "DELETE",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      if (!response || (!response.ok && response.status !== 401))
        throw new Error(
          "The hub is unreachable. This remote is disconnected. Start the hub and retry removal so its credential can be revoked.",
        );
    }
    await this.store.removeRemote(id);
    this.statuses.delete(id);
    this.onChange(this.snapshot());
  }
  private async disconnect(id: string) {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.controller.abort();
    await connection.task;
    this.connections.delete(id);
  }
  private connect(remote: Remote) {
    if (this.closed) return;
    const controller = new AbortController();
    const task = this.run(remote, controller.signal);
    this.connections.set(remote.id, { controller, task });
  }
  private async run(remote: Remote, signal: AbortSignal) {
    while (!signal.aborted) {
      this.status(remote, "connecting", "Connecting…");
      const session = new AbortController();
      const sessionSignal = AbortSignal.any([signal, session.signal]);
      const requests = new Map<string, AbortController>();
      const tasks = new Set<Promise<void>>();
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      const alive = () => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => session.abort(), 30_000);
      };
      try {
        const token = await this.store.remoteToken(remote.id);
        if (!token)
          throw new Error("Pair this remote again. Its credential is unavailable in this session.");
        const endpoint = validateEndpoint(remote.endpoint);
        alive();
        const response = await fetch(`${endpoint}/v1/relay/events`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: sessionSignal,
        });
        await readRelayEvents(response, (event) => {
          alive();
          if (event.type === "ready") {
            this.status(remote, "connected", "Connected. Publications arrive while Scope is open.");
            return;
          }
          if (event.type === "cancel") {
            requests.get(event.id)?.abort();
            return;
          }
          if (
            !artifactRequest(event.method, event.path) ||
            requests.has(event.id) ||
            requests.size >= 16
          )
            throw new Error("The hub sent an invalid publication request.");
          const controller = new AbortController();
          requests.set(event.id, controller);
          const task = this.forward(
            endpoint,
            token,
            event,
            AbortSignal.any([sessionSignal, controller.signal]),
          )
            .catch(() => {})
            .finally(() => {
              requests.delete(event.id);
              tasks.delete(task);
            });
          tasks.add(task);
        });
      } catch (error) {
        if (!signal.aborted)
          this.status(
            remote,
            "error",
            error instanceof Error && error.message.includes("credential")
              ? error.message
              : "Connection lost. Retrying… Check the hub and tailnet if this continues.",
          );
      } finally {
        clearTimeout(heartbeat);
        session.abort();
        await Promise.allSettled(tasks);
      }
      await delay(3000, undefined, { signal }).catch(() => {});
    }
  }
  private async forward(endpoint: string, token: string, event: RelayRequest, signal: AbortSignal) {
    const headers = { Authorization: `Bearer ${token}` };
    const base = `${endpoint}/v1/relay/requests/${event.id}`;
    let body: ReadableStream<Uint8Array> | null | undefined;
    if (event.method !== "GET") {
      const input = await fetch(`${base}/body`, { headers, redirect: "error", signal });
      if (!input.ok) throw new Error("The publication was canceled.");
      body = input.body;
    }
    const init: RequestInit & { duplex: "half" } = {
      method: event.method,
      signal,
      redirect: "error",
      body,
      duplex: "half",
      headers: {
        Authorization: `Bearer ${this.local.token}`,
        ...(event.contentType ? { "Content-Type": event.contentType } : {}),
      },
    };
    const result = await fetch(`${this.local.url}${event.path}`, init);
    const responseHeaders = new Headers(headers);
    responseHeaders.set("scope-response-status", String(result.status));
    for (const name of ["content-type", "content-disposition", "content-security-policy"]) {
      const value = result.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const output: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: responseHeaders,
      body: result.body,
      duplex: "half",
      signal,
      redirect: "error",
    };
    const delivered = await fetch(`${base}/response`, output);
    await readRemoteJson(delivered);
  }
  async close() {
    this.closed = true;
    this.pairing.abort();
    await this.pending;
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}
