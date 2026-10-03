import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  TRANSFER_LIFETIME_MS,
  TransferId,
  TransferName,
  TransferSecret,
  decodeTransferManifest,
  readTransferUrl,
  transferUrl,
  type TransferInvitation,
  type TransferManifest,
} from "@irudd-scope/protocol/transfer";
import type { DesktopStore } from "../desktop-store.ts";
import type { DesktopLifecycle } from "../lifecycle.ts";
import { tabArtifactId } from "../workspace/contract.ts";
import {
  PairScopeInput,
  SendTabInput,
  type ScopePeer,
  type TransferDevices,
  type TransferImport,
  type TransferPreview,
  type TransferStatus,
} from "./contract.ts";
import { decryptTransfer, encryptTransfer, signInvitation, verifyInvitation } from "./crypto.ts";
import type { TransferTransport } from "./transport.ts";
import { validateTransferredContent } from "../library/transfer-import.ts";

const Request = Schema.Struct({
  operation: Schema.Literals(["pair", "inspect", "content", "authorize", "ack"]),
  deviceId: TransferId,
  name: Schema.optionalKey(TransferName),
  blob: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
const Response = Schema.Struct({
  requestNonce: Schema.String,
  sourceId: TransferId,
  ok: Schema.Boolean,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
type LiveInvitation = {
  invitation: TransferInvitation;
  secret: string;
  state: TransferStatus["state"];
  peer?: ScopePeer;
  sourceName: string;
  manifest?: TransferManifest;
  bytes?: Uint8Array;
  close: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  nonces: Map<string, string>;
};

export class TabTransfers {
  private invitations = new Map<string, LiveInvitation>();
  private pending = Promise.resolve();
  private closed = false;
  private activeRequests = 0;
  private pairGenerations = new Map<string, number>();
  private previews = new Map<
    string,
    { sourceId: string; expiresAt: number; manifest: TransferManifest }
  >();

  constructor(
    private readonly store: DesktopStore,
    private readonly lifecycle: DesktopLifecycle,
    private readonly transport: TransferTransport,
    private readonly now = Date.now,
  ) {}

  private enqueue<A>(action: () => Promise<A>): Promise<A> {
    const result = this.pending.then(action);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async devices(): Promise<TransferDevices> {
    return {
      ...(await this.store.transferDevice()),
      peers: await this.store.scopePeers(),
      credentialStorage: this.store.credentialStorage,
    };
  }

  async createPairing(name: string): Promise<TransferStatus> {
    const device = await this.store.transferDevice(decode(TransferName, name));
    return this.enqueue(() =>
      this.create(
        "pair",
        device.deviceId,
        device.name,
        randomUUID(),
        randomBytes(32).toString("base64url"),
      ),
    );
  }

  pairingSecret(id: string): string {
    const live = this.live(id);
    this.assertWaiting(live);
    if (live.invitation.mode !== "pair") throw new Error("This is not a pairing invitation.");
    return live.secret;
  }

  async pair(value: unknown): Promise<void> {
    const input = decode(PairScopeInput, value);
    const invitation = readTransferUrl(input.url);
    if (invitation.mode !== "pair") throw new Error("Use a pairing invitation in Settings.");
    this.assertNotExpired(invitation);
    verifyInvitation(invitation, input.secret);
    const generation = this.pairGenerations.get(invitation.pairId) ?? 0;
    const device = await this.store.transferDevice(input.name);
    if (device.deviceId === invitation.sourceId)
      throw new Error("Pair with another Scope instance.");
    const response = decode(
      Schema.Struct({ deviceId: TransferId, name: TransferName }),
      await this.request(invitation, input.secret, {
        operation: "pair",
        deviceId: device.deviceId,
        name: device.name,
      }),
    );
    if (response.deviceId !== invitation.sourceId)
      throw new Error("The pairing response came from a different Scope.");
    await this.enqueue(async () => {
      if ((this.pairGenerations.get(invitation.pairId) ?? 0) !== generation)
        throw new Error("This pairing was cancelled.");
      this.assertNotExpired(invitation);
      await this.store.saveScopePeer(
        {
          id: invitation.pairId,
          deviceId: response.deviceId,
          name: response.name,
          createdAt: this.now(),
        },
        input.secret,
      );
    });
  }

  async forget(id: string): Promise<void> {
    decode(TransferId, id);
    this.pairGenerations.set(id, (this.pairGenerations.get(id) ?? 0) + 1);
    await this.enqueue(async () => {
      for (const live of this.invitations.values()) {
        if (live.invitation.pairId === id) await this.stop(live, "cancelled");
      }
      await this.store.removeScopePeer(id);
    });
  }

  async send(value: unknown): Promise<TransferStatus> {
    const { tabId, peerId } = decode(SendTabInput, value);
    const { peer, secret } = await this.peer(peerId);
    const device = await this.store.transferDevice();
    const tab = (await this.lifecycle.workspace()).tabs.find((item) => item.id === tabId);
    const artifactId = tab && tabArtifactId(tab);
    if (!tab || !artifactId || !["file", "diagram"].includes(tab.type))
      throw new Error("This tab cannot be transferred.");
    const artifact = await this.lifecycle.artifacts.get(artifactId);
    const draft =
      artifact.kind === "excalidraw" ? await this.lifecycle.artifacts.diagramDraft(tab.id) : null;
    const bytes = draft
      ? Buffer.from(draft.content)
      : await this.lifecycle.artifacts.content(artifact.blob);
    const manifest = decodeTransferManifest({
      version: 1,
      title: artifact.title,
      kind: artifact.kind,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      size: bytes.byteLength,
      blob: createHash("sha256").update(bytes).digest("hex"),
    });
    validateTransferredContent(manifest, bytes);
    return this.enqueue(() =>
      this.create("tab", device.deviceId, device.name, peerId, secret, peer, manifest, bytes),
    );
  }

  private async create(
    mode: "pair" | "tab",
    sourceId: string,
    sourceName: string,
    pairId: string,
    secret: string,
    peer?: ScopePeer,
    manifest?: TransferManifest,
    bytes?: Uint8Array,
  ): Promise<TransferStatus> {
    if (this.closed) throw new Error("Scope transfers are closing.");
    if (mode === "tab") await this.peer(pairId);
    for (const [id, live] of this.invitations) {
      if (
        live.invitation.expiresAt <= this.now() ||
        ["cancelled", "delivered", "expired"].includes(live.state)
      ) {
        await this.stop(live, live.state === "waiting" ? "expired" : live.state);
        this.invitations.delete(id);
      }
    }
    if (this.invitations.size >= 4)
      throw new Error("Finish or cancel an existing transfer before starting another.");
    const id = randomUUID();
    let live: LiveInvitation | undefined;
    const listener = await this.transport.listen((body) => {
      if (!live) throw new Error("The transfer is still starting.");
      return this.handle(live, body);
    });
    if (this.closed) {
      await listener.close();
      throw new Error("Scope transfers are closing.");
    }
    const issuedAt = this.now();
    const invitation = signInvitation(
      {
        version: 2,
        mode,
        id,
        pairId,
        sourceId,
        issuedAt,
        expiresAt: issuedAt + TRANSFER_LIFETIME_MS,
        address: listener.address,
        port: listener.port,
      },
      secret,
    );
    live = {
      invitation,
      secret,
      state: "waiting",
      peer,
      sourceName,
      manifest,
      bytes,
      close: listener.close,
      nonces: new Map(),
    };
    this.invitations.set(id, live);
    const current = live;
    live.timer = setTimeout(() => {
      void this.stop(current, "expired").catch(() => {});
    }, TRANSFER_LIFETIME_MS);
    live.timer.unref?.();
    return this.statusValue(live);
  }

  status(id: string): TransferStatus {
    const live = this.live(id);
    return this.statusValue(live);
  }

  private statusValue(live: LiveInvitation): TransferStatus {
    if (
      this.now() >= live.invitation.expiresAt &&
      !["delivered", "cancelled"].includes(live.state)
    ) {
      void this.stop(live, "expired").catch(() => {});
    }
    return {
      id: live.invitation.id,
      url: transferUrl(live.invitation),
      expiresAt: live.invitation.expiresAt,
      state: live.state,
    };
  }

  cancel(id: string): Promise<void> {
    return this.enqueue(async () => {
      const live = this.live(id);
      if (live.state === "importing")
        throw new Error("The target has already started importing this tab.");
      await this.stop(live, "cancelled");
    });
  }

  private async stop(live: LiveInvitation, state: TransferStatus["state"]) {
    if (live.state === "delivered" && state === "expired") return;
    live.state = state;
    clearTimeout(live.timer);
    live.bytes = undefined;
    live.nonces.clear();
    live.secret = "";
    await live.close();
  }

  private live(id: string) {
    decode(TransferId, id);
    const live = this.invitations.get(id);
    if (!live) throw new Error("This transfer invitation is no longer available.");
    return live;
  }

  private assertNotExpired(invitation: TransferInvitation) {
    if (this.closed || this.now() >= invitation.expiresAt)
      throw new Error("This transfer invitation has expired. Ask the source for a new link.");
  }

  private assertWaiting(live: LiveInvitation) {
    this.assertNotExpired(live.invitation);
    if (["cancelled", "expired", "delivered"].includes(live.state))
      throw new Error("This transfer invitation is no longer available.");
  }

  private async peer(id: string) {
    const peer = (await this.store.scopePeers()).find((item) => item.id === id);
    const secret = peer && (await this.store.transferKey(id));
    if (!peer || !secret) throw new Error("Pair these Scope instances in Settings first.");
    decode(TransferSecret, secret);
    return { peer, secret };
  }

  private async incoming(url: string) {
    const invitation = readTransferUrl(url);
    if (invitation.mode !== "tab") throw new Error("Use pairing invitations in Settings.");
    const { peer, secret } = await this.peer(invitation.pairId);
    if (invitation.sourceId !== peer.deviceId)
      throw new Error("This link came from a different Scope.");
    verifyInvitation(invitation, secret);
    return { invitation, peer, secret };
  }

  async importLink(url: string): Promise<TransferImport> {
    await this.inspect(url);
    return this.import(url);
  }

  async inspect(url: string): Promise<TransferPreview> {
    const { invitation, peer, secret } = await this.incoming(url);
    const receipt = await this.lifecycle.artifacts.transferReceipt(
      invitation.sourceId,
      invitation.id,
    );
    if (receipt)
      return {
        id: invitation.id,
        title: receipt.artifact.title,
        kind: receipt.artifact.kind,
        fileName: receipt.artifact.fileName,
        size: receipt.artifact.size,
        sourceName: peer.name,
        expiresAt: invitation.expiresAt,
        alreadyImported: true,
      };
    this.assertNotExpired(invitation);
    const device = await this.store.transferDevice();
    const manifest = decodeTransferManifest(
      await this.request(invitation, secret, { operation: "inspect", deviceId: device.deviceId }),
    );
    this.assertNotExpired(invitation);
    for (const [id, preview] of this.previews)
      if (preview.expiresAt <= this.now()) this.previews.delete(id);
    if (this.previews.size >= 32 && !this.previews.has(invitation.id))
      throw new Error("Too many transfer previews are open. Wait for an invitation to expire.");
    this.previews.set(invitation.id, {
      sourceId: invitation.sourceId,
      expiresAt: invitation.expiresAt,
      manifest,
    });
    return {
      id: invitation.id,
      title: manifest.title,
      kind: manifest.kind,
      fileName: manifest.fileName,
      size: manifest.size,
      sourceName: peer.name,
      expiresAt: invitation.expiresAt,
    };
  }

  async import(url: string): Promise<TransferImport> {
    const { invitation, secret } = await this.incoming(url);
    const existing = await this.lifecycle.artifacts.transferReceipt(
      invitation.sourceId,
      invitation.id,
    );
    if (existing) return { artifact: existing.artifact, alreadyImported: true };
    this.assertNotExpired(invitation);
    const preview = this.previews.get(invitation.id);
    if (!preview || preview.sourceId !== invitation.sourceId)
      throw new Error("Review this transfer before importing it.");
    const device = await this.store.transferDevice();
    const result = decode(
      Schema.Struct({
        manifest: Schema.Unknown,
        content: Schema.String.check(
          Schema.isMaxLength(45 * 1024 * 1024),
          Schema.isPattern(/^[A-Za-z0-9_-]*$/),
        ),
      }),
      await this.request(invitation, secret, { operation: "content", deviceId: device.deviceId }),
    );
    const manifest = decodeTransferManifest(result.manifest);
    if (JSON.stringify(manifest) !== JSON.stringify(preview.manifest))
      throw new Error("This tab changed after you reviewed it. Inspect the transfer again.");
    const bytes = Buffer.from(result.content, "base64url");
    validateTransferredContent(manifest, bytes);
    await this.request(invitation, secret, {
      operation: "authorize",
      deviceId: device.deviceId,
      blob: manifest.blob,
    });
    this.assertNotExpired(invitation);
    const receipt = await this.enqueue(async () => {
      await this.incoming(url);
      const workspace = await this.lifecycle.workspace();
      return this.lifecycle.artifacts.importTransferredTab(
        invitation.sourceId,
        invitation.id,
        invitation.expiresAt,
        workspace.groups[0].id,
        manifest,
        bytes,
        () => (this.closed ? Infinity : this.now()),
      );
    });
    // The durable local copy survives a lost acknowledgement.
    await this.request(invitation, secret, {
      operation: "ack",
      deviceId: device.deviceId,
      blob: manifest.blob,
    }).catch(() => {});
    return { artifact: receipt.artifact, alreadyImported: receipt.alreadyImported };
  }

  private async request(
    invitation: TransferInvitation,
    secret: string,
    request: typeof Request.Type,
  ): Promise<unknown> {
    this.assertNotExpired(invitation);
    const body = encryptTransfer(secret, invitation, "request", request);
    const nonce = (JSON.parse(body) as { nonce: string }).nonce;
    const wire = await this.transport.request(invitation.address, invitation.port, body);
    const response = decode(Response, decryptTransfer(secret, invitation, "response", wire).value);
    if (response.requestNonce !== nonce || response.sourceId !== invitation.sourceId)
      throw new Error("The transfer response could not be authenticated.");
    if (!response.ok) throw new Error(response.error ?? "The transfer failed.");
    return response.result;
  }

  private async handle(live: LiveInvitation, body: string): Promise<string> {
    if (Buffer.byteLength(body) > 16 * 1024 || this.activeRequests >= 2)
      throw new Error("Transfer request limit reached.");
    this.activeRequests++;
    try {
      return await this.enqueue(async () => {
        this.assertWaiting(live);
        const { nonce, value } = decryptTransfer(live.secret, live.invitation, "request", body);
        const request = decode(Request, value);
        const digest = createHash("sha256").update(body).digest("hex");
        const previous = live.nonces.get(nonce);
        if (previous && previous !== digest) throw new Error("This transfer request was changed.");
        if (!previous && live.nonces.size >= 64) throw new Error("Transfer request limit reached.");
        live.nonces.set(nonce, digest);
        try {
          const result = await this.operation(live, request);
          this.assertNotExpired(live.invitation);
          return encryptTransfer(live.secret, live.invitation, "response", {
            requestNonce: nonce,
            sourceId: live.invitation.sourceId,
            ok: true,
            result,
          });
        } catch (error) {
          return encryptTransfer(live.secret, live.invitation, "response", {
            requestNonce: nonce,
            sourceId: live.invitation.sourceId,
            ok: false,
            error: error instanceof Error ? error.message : "Transfer failed.",
          });
        }
      });
    } finally {
      this.activeRequests--;
    }
  }

  private async operation(live: LiveInvitation, request: typeof Request.Type): Promise<unknown> {
    const invitation = live.invitation;
    if (invitation.mode === "pair") return this.pairRequest(live, request);
    const { peer, secret } = await this.peer(invitation.pairId);
    this.assertWaiting(live);
    if (peer.deviceId !== request.deviceId || secret !== live.secret)
      throw new Error("This invitation is for a different paired Scope.");
    return this.tabRequest(live, request);
  }

  private async pairRequest(live: LiveInvitation, request: typeof Request.Type): Promise<unknown> {
    const invitation = live.invitation;
    if (request.operation !== "pair" || !request.name || request.deviceId === invitation.sourceId)
      throw new Error("Invalid pairing request.");
    if (live.peer && live.peer.deviceId !== request.deviceId)
      throw new Error("This invitation has already paired another Scope.");
    if (live.state === "paired") return { deviceId: invitation.sourceId, name: live.sourceName };
    const peer = {
      id: invitation.pairId,
      deviceId: request.deviceId,
      name: request.name,
      createdAt: this.now(),
    };
    await this.store.saveScopePeer(peer, live.secret);
    this.assertWaiting(live);
    live.peer = peer;
    live.state = "paired";
    return { deviceId: invitation.sourceId, name: live.sourceName };
  }

  private tabRequest(live: LiveInvitation, request: typeof Request.Type): unknown {
    if (request.operation === "inspect") return live.manifest;
    if (request.operation === "content") {
      if (!live.bytes) throw new Error("The source snapshot is no longer available.");
      return { manifest: live.manifest, content: Buffer.from(live.bytes).toString("base64url") };
    }
    if (request.blob !== live.manifest?.blob)
      throw new Error("The transfer checksum does not match.");
    if (request.operation === "authorize") {
      live.state = "importing";
      return {};
    }
    if (request.operation === "ack" && live.state === "importing") {
      live.state = "delivered";
      live.bytes = undefined;
      clearTimeout(live.timer);
      const timer = setTimeout(() => {
        live.nonces.clear();
        live.secret = "";
        void live.close().catch(() => {});
      }, 250);
      timer.unref?.();
      return {};
    }
    throw new Error("This operation is unavailable.");
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.invitations.values()].map((live) => this.stop(live, "cancelled")));
    await this.pending;
  }
}
