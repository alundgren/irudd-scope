import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { decode } from "@irudd-scope/protocol";
import {
  GUEST_VERSION,
  GuestChallenge,
  GuestProof,
  GuestReply,
  type GuestEndpoint,
  type GuestHello,
} from "@irudd-scope/protocol/guest";
import type { GuestPeer } from "@irudd-scope/protocol/guest";
import type { DesktopStore } from "../desktop-store.ts";
import type { GuestPeerStatus, GuestStatus } from "./contract.ts";
import { GuestTransport, type PeerRequest, type PeerResponse } from "./transport.ts";
import { GuestNetworkError } from "./tailscale.ts";

import {
  guestSecret as secret,
  signGuest as sign,
  verifyGuest as verify,
  guestJson as json,
  guestReply as reply,
} from "./auth.ts";
import { GuestPairing } from "./pairing.ts";

type Session = {
  peerId: string;
  token: string;
  epoch: string;
  capabilities: readonly string[];
  controller: AbortController;
};
type Outgoing = Session & { endpoint: GuestEndpoint };
export type GuestOwnerRequest = {
  peer: GuestPeer;
  request: IncomingMessage;
  response: ServerResponse;
  signal: AbortSignal;
};
type OwnerRoute = {
  capability: string;
  method: "GET" | "POST" | "PUT";
  idleMs: number;
  deadlineMs: number;
  handle: (input: GuestOwnerRequest) => Promise<void>;
};

export class GuestConnections {
  private server?: Server;
  private endpoint?: GuestEndpoint;
  private epoch = randomUUID();
  private closed = false;
  private lifetime = new AbortController();
  private enabled = new Map<string, boolean>();
  private states = new Map<string, GuestPeerStatus>();
  private incoming = new Map<string, Session>();
  private outgoing = new Map<string, Outgoing>();
  private challenges = new Map<string, number>();
  private routes = new Map<string, OwnerRoute>();
  private timer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private ticking = false;
  private attempts = new Set<string>();
  private generations = new Map<string, number>();
  private handshakes = new Map<string, AbortController>();
  private retry = new Map<string, { failures: number; at: number }>();
  private operations = Promise.resolve();

  readonly pairing: GuestPairing;
  constructor(
    private readonly store: DesktopStore,
    private readonly transport = new GuestTransport(),
  ) {
    this.pairing = new GuestPairing(
      store,
      this.transport,
      async () => {
        await this.ensureTransport(true);
        return this.endpoint!;
      },
      (id, enabled) => this.setEnabled(id, enabled),
    );
  }
  async devices() {
    return {
      ...(await this.store.guestDevice()),
      peers: await this.store.guestPeers(),
      credentialStorage: this.store.credentialStorage,
    };
  }
  cancelPairing(id: string) {
    this.pairing.cancel(id);
    return this.setEnabled(id, false).catch(() => {});
  }

  register(route: string, definition: OwnerRoute) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(route) ||
      route.startsWith("pair-") ||
      ["hello", "challenge", "identity", "revoke"].includes(route) ||
      this.routes.has(route) ||
      ![definition.idleMs, definition.deadlineMs].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647,
      )
    )
      throw new Error("Invalid guest owner route.");
    this.routes.set(route, definition);
    return () => this.routes.delete(route);
  }
  private capabilities() {
    return [
      ...new Set(["session", ...[...this.routes.values()].map((route) => route.capability)]),
    ].sort();
  }
  async start() {
    const settings = await this.store.guestSettings();
    this.enabled = new Map(Object.entries(settings.enabled));
    this.schedule(0);
  }
  async status(): Promise<GuestStatus> {
    return {
      credentialStorage: this.store.credentialStorage,
      peers: (await this.store.guestPeers()).map(
        (peer) =>
          this.states.get(peer.id) ?? {
            peerId: peer.id,
            enabled: this.enabled.get(peer.id) === true,
            state: this.enabled.get(peer.id) ? "setup" : "disabled",
          },
      ),
    };
  }
  private state(peerId: string, state: GuestPeerStatus["state"], message?: string) {
    this.states.set(peerId, {
      peerId,
      enabled: this.enabled.get(peerId) === true,
      state,
      ...(message ? { message } : {}),
    });
  }
  private async peer(id: string) {
    const peer = (await this.store.guestPeers()).find((item) => item.id === id);
    const key = peer && (await this.store.guestKey(id));
    if (!peer || !key)
      throw new Error("Guest pairing is incomplete. Forget this Scope and pair again.");
    return { peer, key };
  }
  private allowed(id: string) {
    if (this.closed || !this.enabled.get(id))
      throw new Error("Guest sharing is disabled for this Scope.");
  }
  setEnabled(peerId: string, enabled: boolean) {
    const generation = (this.generations.get(peerId) ?? 0) + 1;
    this.generations.set(peerId, generation);
    // Revoke synchronously, before waiting for credential or preference writes.
    if (!enabled) {
      this.pairing.cancel(peerId);
      this.enabled.set(peerId, false);
      this.revoke(peerId);
      this.state(peerId, "disabled");
    }
    const result = this.operations.then(async () => {
      if (enabled) await this.peer(peerId);
      else if (!(await this.store.guestPeers()).some((peer) => peer.id === peerId)) {
        this.enabled.delete(peerId);
        this.states.delete(peerId);
        if (!this.handshakes.has(peerId)) this.generations.delete(peerId);
        return;
      }
      await this.store.updateGuestSettings({ peerId, enabled });
      if (this.closed || this.generations.get(peerId) !== generation) return;
      this.enabled.set(peerId, enabled);
      this.retry.delete(peerId);
      this.state(peerId, enabled ? "setup" : "disabled");
      this.schedule(0);
    });
    this.operations = result.catch(() => {});
    return result;
  }
  forget(peerId: string) {
    this.pairing.cancel(peerId);
    this.generations.set(peerId, (this.generations.get(peerId) ?? 0) + 1);
    this.enabled.set(peerId, false);
    this.revoke(peerId);
    const result = this.operations.then(async () => {
      await this.store.updateGuestSettings({ peerId, enabled: false });
      await this.store.removeGuestPeer(peerId);
      this.states.delete(peerId);
      this.retry.delete(peerId);
    });
    this.operations = result.catch(() => {});
    return result;
  }
  private revoke(peerId: string) {
    this.handshakes.get(peerId)?.abort();
    this.outgoing.get(peerId)?.controller.abort();
    this.outgoing.delete(peerId);
    for (const [token, session] of this.incoming)
      if (session.peerId === peerId) {
        session.controller.abort();
        this.incoming.delete(token);
      }
  }
  async reconnect(peerId?: string) {
    if (peerId) this.retry.delete(peerId);
    else this.retry.clear();
    this.schedule(0);
  }
  private schedule(delay = 15000) {
    clearTimeout(this.timer);
    if (!this.closed)
      this.timer = setTimeout(() => {
        void this.tick();
      }, delay);
  }
  private transportLost() {
    if (this.closed) return;
    this.endpoint = undefined;
    void this.transport.close();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    for (const id of this.enabled.keys()) this.revoke(id);
    this.epoch = randomUUID();
    this.challenges.clear();
    this.schedule(1000);
  }
  private async ensureTransport(repairAddress = false) {
    if (this.endpoint) {
      try {
        const local = await this.transport.network.discover(this.lifetime.signal);
        if (local.address === this.endpoint.address) return;
        this.transportLost();
      } catch (error) {
        this.transportLost();
        throw error;
      }
    }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.transport.close();
      if (this.server) {
        this.server.closeAllConnections();
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = undefined;
      }
      const settings = await this.store.guestSettings();
      const local = await this.transport.network.discover(this.lifetime.signal);
      if (settings.address && settings.address !== local.address && !repairAddress)
        throw new GuestNetworkError(
          "The local Tailscale address changed. Forget the peer and create a new guest invitation to repair the connection.",
        );
      const server = createServer(
        { maxHeaderSize: 16384, connectionsCheckingInterval: 1000 },
        (request, response) => {
          void this.accept(request, response).catch(() => {
            if (!response.headersSent) reply(response, 403, { error: "Guest access rejected." });
            else response.destroy();
          });
        },
      );
      server.maxConnections = 32;
      server.headersTimeout = 10000;
      // Body deadlines depend on the authenticated operation, not HTTP parsing.
      server.requestTimeout = 0;
      server.timeout = 0;
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
          reject(
            new GuestNetworkError(
              error.code === "EADDRINUSE"
                ? "The saved guest connection port is in use. Close the other app using it, then retry."
                : error.code === "EADDRNOTAVAIL"
                  ? "The local Tailscale IPv4 interface is unavailable. Reconnect Tailscale, then retry."
                  : "The guest listener could not open on the Tailscale interface. Check access to its port, then retry.",
            ),
          ),
        );
        server.listen(settings.port ?? 0, local.address, resolve);
      });
      const port = (server.address() as { port: number }).port;
      await this.store.updateGuestSettings({ port, address: local.address });
      if (this.closed) throw new Error("Guest connections are closing.");
      this.endpoint = { address: local.address, port };
      this.epoch = randomUUID();
      this.challenges.clear();
      if (this.closed) throw new Error("Guest connections are closing.");
    })()
      .catch(async (error: unknown) => {
        this.endpoint = undefined;
        await this.transport.close();
        if (this.server) {
          this.server.closeAllConnections();
          this.server.close();
          this.server = undefined;
        }
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const peers = (await this.store.guestPeers()).filter((peer) => this.enabled.get(peer.id));
      if (!peers.length && !this.pairing.active) {
        await this.transport.close();
        this.endpoint = undefined;
        if (this.server) {
          this.server.closeAllConnections();
          await new Promise<void>((resolve) => this.server!.close(() => resolve()));
          this.server = undefined;
        }
        return;
      }
      await this.ensureTransport();
      for (const peer of peers) {
        if (this.closed) return;
        if (this.attempts.has(peer.id) || (this.retry.get(peer.id)?.at ?? 0) > Date.now()) continue;
        const endpoint = await this.store.guestEndpoint(peer.id);
        if (!endpoint) {
          this.state(peer.id, "setup", "Pairing is incomplete. Forget this Scope and pair again.");
          continue;
        }
        try {
          if (this.outgoing.has(peer.id)) {
            const response = await this.request(peer.id, "identity", {
              signal: this.lifetime.signal,
              deadlineMs: 10000,
              idleMs: 10000,
            });
            await json(response.body);
            if (response.status !== 200) throw new Error("Guest connection ended.");
          } else await this.connectPeer(peer.id, endpoint);
          this.retry.delete(peer.id);
        } catch (error) {
          this.revoke(peer.id);
          if (!this.enabled.get(peer.id)) continue;
          const failures = (this.retry.get(peer.id)?.failures ?? 0) + 1;
          this.retry.set(peer.id, {
            failures,
            at:
              Date.now() +
              Math.min(60000, 1000 * 2 ** Math.min(failures, 6)) +
              Math.random() * 1000,
          });
          if (!["update-required", "access-denied"].includes(this.states.get(peer.id)?.state ?? ""))
            this.state(
              peer.id,
              "offline",
              error instanceof GuestNetworkError
                ? error.message
                : "Waiting for the other Scope. Both apps must be open with guest sharing enabled.",
            );
        }
      }
    } catch (error) {
      for (const [id, enabled] of this.enabled)
        if (enabled)
          this.state(
            id,
            "offline",
            error instanceof Error ? error.message : "Guest connection unavailable.",
          );
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }
  private async hello(
    peer: GuestPeer,
    challenge: { epoch: string; challenge: string },
  ): Promise<GuestHello> {
    const device = await this.store.guestDevice();
    if (!this.endpoint) throw new Error("Guest connection is not ready.");
    return {
      version: GUEST_VERSION,
      pairId: peer.id,
      deviceId: device.deviceId,
      targetId: peer.deviceId,
      name: device.name,
      nonce: secret(),
      epoch: this.epoch,
      targetEpoch: challenge.epoch,
      challenge: challenge.challenge,
      enabled: this.enabled.get(peer.id) === true,
      capabilities: this.capabilities(),
      endpoint: this.endpoint,
      timestamp: Date.now(),
    };
  }
  private async connectPeer(peerId: string, endpoint: GuestEndpoint) {
    this.allowed(peerId);
    if (this.attempts.has(peerId))
      throw new Error("This guest connection is already connecting. Retry shortly.");
    this.attempts.add(peerId);
    if (!this.outgoing.has(peerId)) this.state(peerId, "connecting");
    const controller = new AbortController();
    this.handshakes.set(peerId, controller);
    const generation = this.generations.get(peerId) ?? 0;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const epoch = this.epoch;
    try {
      const { peer, key } = await this.peer(peerId);
      const challengeResponse = await this.transport.request(endpoint, "/guest/challenge", {
        signal,
        deadlineMs: 15000,
        idleMs: 10000,
      });
      const challengeData = await json(challengeResponse.body);
      if (challengeResponse.status === 403) {
        this.state(
          peerId,
          "access-denied",
          `${peer.name} rejected guest access. Check sharing and pairing on that Scope, then retry in Other Scopes.`,
        );
        throw new Error("Guest access rejected.");
      }
      const challenge = decode(GuestChallenge, challengeData);
      if (challengeResponse.status !== 200)
        throw new Error("Guest protocol unavailable. Update the other Scope.");
      const hello = await this.hello(peer, challenge);
      const response = await this.transport.request(endpoint, "/guest/hello", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ hello, mac: sign(key, "hello", hello) })),
        signal,
        deadlineMs: 15000,
        idleMs: 10000,
      });
      const replyData = await json(response.body);
      if (response.status === 403) {
        this.state(
          peerId,
          "access-denied",
          `${peer.name} rejected guest access. Check sharing and pairing on that Scope, then retry in Other Scopes.`,
        );
        throw new Error("Guest access rejected.");
      }
      const result = decode(GuestReply, replyData);
      const { mac, ...unsigned } = result;
      verify(key, "reply", unsigned, mac);
      const local = await this.store.guestDevice();
      if (
        result.requestNonce !== hello.nonce ||
        result.hello.deviceId !== peer.deviceId ||
        result.hello.targetId !== local.deviceId ||
        result.hello.pairId !== peerId ||
        result.hello.targetEpoch !== this.epoch ||
        !result.hello.enabled ||
        response.status !== 200
      )
        throw new Error("The other Scope did not authorize guest sharing.");
      if (
        result.hello.version !== GUEST_VERSION ||
        !result.hello.capabilities.includes("session")
      ) {
        this.state(
          peerId,
          "update-required",
          result.hello.version > GUEST_VERSION
            ? "Update this Scope to connect."
            : `Update ${peer.name} to connect.`,
        );
        throw new Error("Update Scope to use guest connections.");
      }
      this.allowed(peerId);
      if (
        signal.aborted ||
        generation !== (this.generations.get(peerId) ?? 0) ||
        epoch !== this.epoch ||
        (await this.store.guestKey(peerId)) !== key
      )
        throw new Error("Guest connection changed while connecting.");
      if (
        result.hello.endpoint.address !== endpoint.address ||
        result.hello.endpoint.port !== endpoint.port
      )
        throw new GuestNetworkError(
          "The guest endpoint changed. Forget this Scope and pair again to repair the connection.",
        );

      this.allowed(peerId);
      signal.throwIfAborted();
      this.outgoing.get(peerId)?.controller.abort();
      this.outgoing.set(peerId, {
        peerId,
        token: result.session,
        endpoint: result.hello.endpoint,
        epoch: result.hello.epoch,
        capabilities: result.hello.capabilities,
        controller,
      });
      this.state(peerId, "connected");
    } catch (error) {
      controller.abort();
      if (error instanceof GuestNetworkError) throw error;
      throw new Error(
        ["update-required", "access-denied"].includes(this.states.get(peerId)?.state ?? "")
          ? this.states.get(peerId)!.message
          : "Could not authenticate the guest connection. Confirm sharing is enabled on both Scopes, update incompatible apps, then retry.",
      );
    } finally {
      this.handshakes.delete(peerId);
      this.attempts.delete(peerId);
    }
  }
  supports(peerId: string, capability: string): boolean {
    return this.outgoing.get(peerId)?.capabilities.includes(capability) === true;
  }

  access(peerId: string): AbortSignal {
    this.allowed(peerId);
    const session = this.outgoing.get(peerId);
    if (!session) throw new Error("The other Scope is offline.");
    session.controller.signal.throwIfAborted();
    return session.controller.signal;
  }

  async request(peerId: string, route: string, options: PeerRequest): Promise<PeerResponse> {
    this.allowed(peerId);
    const session = this.outgoing.get(peerId);
    if (!session) throw new Error("The other Scope is offline.");
    const definition = this.routes.get(route);
    if (
      route !== "identity" &&
      (!definition || !session.capabilities.includes(definition.capability))
    )
      throw new Error("Update the other Scope to use this guest operation.");
    return this.transport.request(session.endpoint, "/guest/" + route, {
      ...options,
      headers: { ...options.headers, Authorization: "Bearer " + session.token },
      signal: AbortSignal.any([options.signal, session.controller.signal, this.lifetime.signal]),
    });
  }
  private async accept(request: IncomingMessage, response: ServerResponse) {
    const operation = new AbortController();
    const socket = request.socket;
    const expire = () => operation.abort();
    const abort = () => {
      request.destroy();
      response.destroy();
    };
    let deadline = setTimeout(expire, 30000);
    socket.setTimeout(30000);
    socket.on("timeout", expire);
    operation.signal.addEventListener("abort", abort, { once: true });
    response.once("close", () => {
      clearTimeout(deadline);
      socket.removeListener("timeout", expire);
      operation.signal.removeEventListener("abort", abort);
      operation.abort();
    });
    if (this.closed || !this.endpoint || request.headers.origin !== undefined)
      return reply(response, 403, { error: "Guest access rejected." });
    if (request.method === "POST" && request.url?.startsWith("/guest/pair-"))
      return this.pairing.accept(request.url.slice("/guest/pair-".length), request, response);
    if (request.method === "GET" && request.url === "/guest/challenge") {
      for (const [nonce, expires] of this.challenges)
        if (expires < Date.now()) this.challenges.delete(nonce);
      if (this.challenges.size >= 64) return reply(response, 429, { error: "Retry shortly." });
      const challenge = secret();
      this.challenges.set(challenge, Date.now() + 30000);
      return reply(response, 200, { epoch: this.epoch, challenge });
    }
    if (request.method === "POST" && request.url === "/guest/hello") {
      if (request.headers["content-type"] !== "application/json")
        throw new Error("Invalid handshake.");
      const proof = decode(GuestProof, await json(request));
      operation.signal.throwIfAborted();
      const generation = this.generations.get(proof.hello.pairId) ?? 0;
      const epoch = this.epoch;
      const hello = proof.hello;
      const { peer, key } = await this.peer(hello.pairId);
      verify(key, "hello", hello, proof.mac);
      this.allowed(peer.id);
      const device = await this.store.guestDevice();
      if (
        hello.targetId !== device.deviceId ||
        hello.deviceId !== peer.deviceId ||
        hello.targetEpoch !== this.epoch ||
        !hello.enabled ||
        Math.abs(Date.now() - hello.timestamp) > 90000 ||
        (this.challenges.get(hello.challenge) ?? 0) < Date.now()
      )
        throw new Error("Stale guest handshake.");
      this.challenges.delete(hello.challenge);
      const own = await this.hello(peer, { epoch: hello.epoch, challenge: hello.nonce });
      const token = secret();
      const unsigned = { hello: own, requestNonce: hello.nonce, session: token };
      if (hello.version === GUEST_VERSION && hello.capabilities.includes("session")) {
        this.allowed(peer.id);
        if ((await this.store.guestKey(peer.id)) !== key) throw new Error("Pairing changed.");
        operation.signal.throwIfAborted();
        await this.transport.network.peer(hello.endpoint, operation.signal);
        const savedEndpoint = await this.store.guestEndpoint(peer.id);
        if (
          !savedEndpoint ||
          savedEndpoint.address !== hello.endpoint.address ||
          savedEndpoint.port !== hello.endpoint.port
        )
          throw new Error(
            "The guest endpoint changed. Forget this Scope and pair again to repair it.",
          );
        this.allowed(peer.id);
        if (epoch !== this.epoch || generation !== (this.generations.get(peer.id) ?? 0))
          throw new Error("Guest access changed.");
        for (const [oldToken, previous] of this.incoming)
          if (previous.peerId === peer.id) {
            previous.controller.abort();
            this.incoming.delete(oldToken);
          }
        this.incoming.set(token, {
          peerId: peer.id,
          token,
          epoch: hello.epoch,
          capabilities: hello.capabilities,
          controller: new AbortController(),
        });
        this.retry.delete(peer.id);
        this.schedule(0);
      }
      return reply(response, 200, { ...unsigned, mac: sign(key, "reply", unsigned) });
    }
    const auth = request.headers.authorization;
    const session =
      typeof auth === "string" && auth.startsWith("Bearer ")
        ? this.incoming.get(auth.slice(7))
        : undefined;
    if (!session) throw new Error("Guest session ended.");
    this.allowed(session.peerId);
    const { peer } = await this.peer(session.peerId);
    if (session.controller.signal.aborted) throw new Error("Guest session ended.");
    if (request.method === "GET" && request.url === "/guest/identity")
      return reply(response, 200, {
        deviceId: (await this.store.guestDevice()).deviceId,
        version: GUEST_VERSION,
      });
    const route = this.routes.get(request.url?.replace(/^\/guest\//, "") ?? "");
    if (
      !request.url?.startsWith("/guest/") ||
      !route ||
      request.method !== route.method ||
      !session.capabilities.includes(route.capability)
    )
      return reply(response, 404, { error: "Unsupported guest operation." });
    clearTimeout(deadline);
    deadline = setTimeout(expire, route.deadlineMs);
    socket.setTimeout(route.idleMs);
    const signal = AbortSignal.any([
      session.controller.signal,
      this.lifetime.signal,
      operation.signal,
    ]);
    signal.addEventListener("abort", abort, { once: true });
    response.once("close", () => signal.removeEventListener("abort", abort));
    signal.throwIfAborted();
    await route.handle({ peer, request, response, signal });
  }
  async close() {
    this.closed = true;
    this.pairing.close();
    clearTimeout(this.timer);
    this.lifetime.abort();
    for (const peerId of this.enabled.keys()) this.revoke(peerId);
    await this.starting?.catch(() => {});
    await this.transport.close();
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    await this.operations;
  }
}
