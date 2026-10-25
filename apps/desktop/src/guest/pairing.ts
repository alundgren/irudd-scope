import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decode } from "@irudd-scope/protocol";
import {
  GUEST_INVITATION_MS,
  GuestInvitation,
  GuestPairRequest,
  GuestPairReply,
  type GuestClaim,
  type GuestEndpoint,
} from "@irudd-scope/protocol/guest";
import type { DesktopStore } from "../desktop-store.ts";
import type { GuestPairingStatus } from "./contract.ts";
import type { GuestTransport } from "./transport.ts";
import { guestSecret, signGuest, verifyGuest, guestJson, guestReply } from "./auth.ts";

type Pending = {
  invitation: GuestInvitation;
  claim?: GuestClaim;
  direction: "invite" | "join";
  state: GuestPairingStatus["state"];
  controller: AbortController;
  failures: number;
  verified: boolean;
  busy: boolean;
  message?: string;
  endState?: "cancelled" | "expired" | "failed";
  revoking?: Promise<boolean>;
};

export class GuestPairing {
  private pending?: Pending;
  private preparing = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private store: DesktopStore,
    private transport: GuestTransport,
    private endpoint: () => Promise<GuestEndpoint>,
    private enable: (id: string, enabled: boolean) => Promise<void>,
    private revoke: (id: string) => Promise<void>,
  ) {}
  get active() {
    if (this.pending) this.expire(this.pending);
    return (
      this.preparing ||
      (!!this.pending &&
        !["complete", "cancelled", "expired", "failed", "revocation-failed"].includes(
          this.pending.state,
        ))
    );
  }
  status(): GuestPairingStatus | undefined {
    const p = this.pending;
    if (!p) return;
    this.expire(p);
    return {
      id: p.invitation.id,
      direction: p.direction,
      state: p.state,
      expiresAt: p.invitation.expiresAt,
      peerName: p.direction === "join" ? p.invitation.device.name : p.claim?.device.name,
      ...(p.message ? { message: p.message } : {}),
    };
  }
  private expire(p: Pending) {
    if (
      Date.now() >= p.invitation.expiresAt &&
      !["complete", "cancelled", "expired", "failed", "cancelling", "revocation-failed"].includes(
        p.state,
      )
    )
      void this.stop(p, "expired");
  }
  private current(p: Pending) {
    this.expire(p);
    if (Date.now() >= p.invitation.expiresAt) throw new Error("This guest invitation expired.");
    if (this.pending !== p || ["cancelled", "expired", "failed"].includes(p.state))
      throw new Error("This guest invitation ended. Create a new invitation.");
    p.controller.signal.throwIfAborted();
  }
  private replace() {
    if (
      this.preparing ||
      (this.pending &&
        !["complete", "cancelled", "expired", "failed"].includes(this.status()!.state))
    )
      throw new Error("Finish or cancel the current guest invitation first.");
    this.pending?.controller.abort();
    clearTimeout(this.timer);
  }
  async create(name: string) {
    this.replace();
    this.preparing = true;
    try {
      const device = await this.store.guestDevice(name);
      const endpoint = await this.endpoint();
      this.pending = {
        invitation: {
          version: 2,
          id: randomUUID(),
          device,
          endpoint,
          expiresAt: Date.now() + GUEST_INVITATION_MS,
          secret: guestSecret(),
        },
        direction: "invite",
        state: "waiting",
        controller: new AbortController(),
        failures: 0,
        verified: false,
        busy: false,
      };
      return this.status()!;
    } finally {
      this.preparing = false;
    }
  }
  invitation(id: string) {
    const p = this.pending;
    if (!p || p.invitation.id !== id || p.direction !== "invite" || p.state !== "waiting")
      throw new Error("Create a new guest invitation first.");
    this.current(p);
    return "scope-guest://v2/#" + Buffer.from(JSON.stringify(p.invitation)).toString("base64url");
  }
  async inspect(text: string, name: string) {
    this.replace();
    let invitation: GuestInvitation;
    try {
      if (!/^scope-guest:\/\/v2\/#[-_A-Za-z0-9]{1,8192}$/.test(text)) throw new Error();
      invitation = decode(
        GuestInvitation,
        JSON.parse(Buffer.from(text.split("#")[1]!, "base64url").toString()),
      );
    } catch {
      throw new Error(
        "This guest invitation is invalid. Copy a new invitation from the other Scope.",
      );
    }
    if (
      invitation.expiresAt <= Date.now() ||
      invitation.expiresAt > Date.now() + GUEST_INVITATION_MS
    )
      throw new Error("This guest invitation expired. Ask for a new invitation.");
    this.preparing = true;
    try {
      const device = await this.store.guestDevice(name);
      if (device.deviceId === invitation.device.deviceId)
        throw new Error("Use this invitation on the other Scope.");
      if (
        (await this.store.guestPeers()).some((peer) => peer.deviceId === invitation.device.deviceId)
      )
        throw new Error("This Scope is already paired. Forget it before pairing again.");
      const endpoint = await this.endpoint();
      this.pending = {
        invitation,
        claim: { invitationId: invitation.id, attemptId: randomUUID(), device, endpoint },
        direction: "join",
        state: "review",
        controller: new AbortController(),
        failures: 0,
        verified: false,
        busy: false,
      };
      return this.status()!;
    } finally {
      this.preparing = false;
    }
  }
  private signed(p: Pending, value: unknown) {
    const { secret: _secret, ...invitation } = p.invitation;
    return { invitation, value };
  }
  private key(p: Pending) {
    return signGuest(p.invitation.secret, "pair-key", this.signed(p, p.claim));
  }
  private async save(p: Pending) {
    this.current(p);
    const remote = p.direction === "invite" ? p.claim!.device : p.invitation.device;
    const endpoint = p.direction === "invite" ? p.claim!.endpoint : p.invitation.endpoint;
    await this.store.saveGuestPeer(
      { id: p.invitation.id, ...remote, createdAt: Date.now() },
      this.key(p),
      endpoint,
    );
    this.current(p);
  }
  private async send(p: Pending, action: string, endpoint = p.invitation.endpoint) {
    this.current(p);
    const unsigned = { claim: p.claim!, nonce: guestSecret() };
    const response = await this.transport.request(endpoint, "/guest/pair-" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(
        JSON.stringify({
          ...unsigned,
          mac: signGuest(p.invitation.secret, "pair-" + action, this.signed(p, unsigned)),
        }),
      ),
      signal: p.controller.signal,
      // A claim waits for the other desktop's bounded return-connection check.
      deadlineMs: action === "claim" ? 30000 : 15000,
      idleMs: action === "claim" ? 25000 : 10000,
    });
    const data = await guestJson(response.body);
    this.current(p);
    if (response.status !== 200)
      throw new Error("Guest pairing was rejected or expired. Cancel and create a new invitation.");
    const result = decode(GuestPairReply, data);
    const { mac, ...value } = result;
    verifyGuest(p.invitation.secret, "pair-" + action + "-reply", this.signed(p, value), mac);
    if (
      result.invitationId !== p.invitation.id ||
      result.attemptId !== p.claim!.attemptId ||
      result.nonce !== unsigned.nonce
    )
      throw new Error("The guest pairing reply belongs to another attempt.");
    return result.state;
  }
  async approve(id: string) {
    const p = this.pending;
    if (!p || p.invitation.id !== id || p.busy || p.state !== "review")
      throw new Error("Review the current guest request first.");
    this.current(p);
    p.busy = true;
    p.state = "saving";
    try {
      if (p.direction === "join") {
        const state = await this.send(p, "claim");
        if (state !== "pending") throw new Error("Unexpected guest pairing state.");
        p.state = "pending";
        this.poll(p);
      } else {
        if (!p.verified) throw new Error("The other Scope's endpoint has not been verified.");
        await this.save(p);
        p.state = "pending";
      }
    } catch (error) {
      await this.fail(p, error);
      throw error;
    } finally {
      p.busy = false;
    }
  }
  private poll(p: Pending) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.finish(p), 1000);
  }
  private async finish(p: Pending) {
    try {
      this.current(p);
      const state = await this.send(p, "status");
      if (state === "pending") {
        this.poll(p);
        return;
      }
      if (state !== "ready" && state !== "complete")
        throw new Error("Unexpected guest pairing state.");
      p.state = "saving";
      await this.save(p);
      this.current(p);
      await this.store.confirmGuestPeer(p.invitation.id);
      this.current(p);
      if ((await this.send(p, "commit")) !== "complete")
        throw new Error("Guest pairing did not complete.");
      this.current(p);
      await this.enable(p.invitation.id, true);
      this.current(p);
      p.state = "complete";
    } catch (error) {
      await this.fail(p, error);
    }
  }
  private async fail(p: Pending, error: unknown) {
    if (this.pending !== p) return;
    if (p.state === "revocation-failed" || p.state === "cancelled" || p.state === "expired") return;
    if (!p.endState) {
      p.message =
        error instanceof Error ? error.message : "Guest pairing failed. Cancel and try again.";
    }
    await this.stop(p, p.endState ?? "failed");
  }
  incomplete(id: string) {
    const p = this.pending;
    return !!p && p.invitation.id === id && !["complete", "cancelled"].includes(p.state);
  }
  private stop(p: Pending, state: "cancelled" | "expired" | "failed"): Promise<boolean> {
    if (state === "cancelled" || !p.endState) p.endState = state;
    if (p.revoking) return p.revoking;
    p.state = "cancelling";
    p.controller.abort();
    clearTimeout(this.timer);
    p.revoking = this.revoke(p.invitation.id)
      .then(
        () => {
          p.state = p.endState!;
          if (p.state !== "failed") p.message = undefined;
          return true;
        },
        (error: unknown) => {
          p.state = "revocation-failed";
          p.message =
            error instanceof Error
              ? error.message
              : "Could not save cancellation. Retry before restarting.";
          return false;
        },
      )
      .finally(() => {
        p.revoking = undefined;
      });
    return p.revoking;
  }
  async cancel(id: string) {
    const p = this.pending;
    if (!p || p.invitation.id !== id)
      throw new Error("This guest invitation is no longer available.");
    if (p.state === "cancelled") return;
    if (!(await this.stop(p, "cancelled"))) throw new Error(p.message);
  }
  async close() {
    clearTimeout(this.timer);
    const p = this.pending;
    if (p && this.incomplete(p.invitation.id)) await this.cancel(p.invitation.id);
  }
  async accept(action: string, request: IncomingMessage, response: ServerResponse) {
    const p = this.pending;
    if (!p || request.headers["content-type"] !== "application/json" || ++p.failures > 512)
      throw new Error("Guest invitation unavailable.");
    this.current(p);
    const message = decode(GuestPairRequest, await guestJson(request));
    const { mac, ...unsigned } = message;
    verifyGuest(p.invitation.secret, "pair-" + action, this.signed(p, unsigned), mac);
    this.current(p);
    if (action === "claim" && p.state === "complete")
      throw new Error("Guest invitation already used.");
    const claim = message.claim;
    if (claim.invitationId !== p.invitation.id) throw new Error("Wrong invitation.");
    if (action === "claim" && p.direction === "invite" && !p.claim) {
      if (p.state !== "waiting" || p.busy || claim.device.deviceId === p.invitation.device.deviceId)
        throw new Error("Guest invitation already used.");
      if ((await this.store.guestPeers()).some((peer) => peer.deviceId === claim.device.deviceId))
        throw new Error("This Scope is already paired.");
      this.current(p);
      if (p.claim) throw new Error("Guest invitation already used.");
      p.claim = claim;
      p.busy = true;
      try {
        if ((await this.send(p, "verify", claim.endpoint)) !== "verified")
          throw new Error("Reciprocal endpoint verification failed.");
        p.verified = true;
        p.state = "review";
      } catch (error) {
        await this.fail(p, error);
        throw error;
      } finally {
        p.busy = false;
      }
    }
    if (JSON.stringify(p.claim) !== JSON.stringify(claim))
      throw new Error("Another pairing attempt already claimed this invitation.");
    let state: "pending" | "ready" | "complete" | "verified";
    if (action === "verify" && p.direction === "join" && p.state === "saving") {
      p.verified = true;
      state = "verified";
    } else if (
      p.direction === "invite" &&
      p.verified &&
      ["claim", "status", "commit"].includes(action)
    ) {
      state = p.state === "complete" ? "complete" : p.state === "pending" ? "ready" : "pending";
      if (action === "commit" && p.state !== "complete") {
        if (p.state !== "pending" || p.busy)
          throw new Error("Both Scopes must finish protecting the pair first.");
        p.busy = true;
        try {
          this.current(p);
          await this.store.confirmGuestPeer(p.invitation.id);
          this.current(p);
          await this.enable(p.invitation.id, true);
          this.current(p);
          p.state = "complete";
          state = "complete";
        } catch (error) {
          await this.fail(p, error);
          throw error;
        } finally {
          p.busy = false;
        }
      }
    } else throw new Error("Guest pairing step is unavailable.");
    const value = {
      invitationId: p.invitation.id,
      attemptId: claim.attemptId,
      nonce: message.nonce,
      state,
    };
    guestReply(response, 200, {
      ...value,
      mac: signGuest(p.invitation.secret, "pair-" + action + "-reply", this.signed(p, value)),
    });
  }
}
