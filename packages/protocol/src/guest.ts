import { Schema } from "effect";
import { Artifact, PublicationTabId, Revision } from "./index.ts";
export const GuestId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export const GuestSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const GuestName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const GuestDevice = Schema.Struct({ deviceId: GuestId, name: GuestName });
export type GuestDevice = typeof GuestDevice.Type;
export const GuestPeer = Schema.Struct({
  id: GuestId,
  ...GuestDevice.fields,
  createdAt: Schema.Int,
});
export type GuestPeer = typeof GuestPeer.Type;
export const GUEST_INVITATION_MS = 5 * 60_000;

export const GUEST_VERSION = 2;
export const GuestAddress = Schema.String.check(
  Schema.isPattern(
    /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/,
  ),
);
export const GuestEndpoint = Schema.Struct({
  address: GuestAddress,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type GuestEndpoint = typeof GuestEndpoint.Type;
export const GuestHello = Schema.Struct({
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  pairId: GuestId,
  deviceId: GuestId,
  targetId: GuestId,
  name: GuestName,
  nonce: GuestSecret,
  epoch: GuestId,
  targetEpoch: GuestId,
  challenge: GuestSecret,
  enabled: Schema.Boolean,
  capabilities: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))).check(
    Schema.isMaxLength(32),
  ),
  endpoint: GuestEndpoint,
  timestamp: Schema.Int,
});
export type GuestHello = typeof GuestHello.Type;
export const GuestProof = Schema.Struct({ hello: GuestHello, mac: GuestSecret });
export const GuestReply = Schema.Struct({
  hello: GuestHello,
  requestNonce: GuestSecret,
  session: GuestSecret,
  mac: GuestSecret,
});
export const GuestPairCredential = Schema.Struct({
  key: GuestSecret,
  endpoint: GuestEndpoint,
  confirmed: Schema.Boolean,
});
export const GuestInvitation = Schema.Struct({
  version: Schema.Literal(2),
  id: GuestId,
  device: GuestDevice,
  endpoint: GuestEndpoint,
  expiresAt: Schema.Int,
  secret: GuestSecret,
});
export type GuestInvitation = typeof GuestInvitation.Type;
export const GuestClaim = Schema.Struct({
  invitationId: GuestId,
  attemptId: GuestId,
  device: GuestDevice,
  endpoint: GuestEndpoint,
});
export type GuestClaim = typeof GuestClaim.Type;
export const GuestPairRequest = Schema.Struct({
  claim: GuestClaim,
  nonce: GuestSecret,
  mac: GuestSecret,
});
export const GuestPairReply = Schema.Struct({
  invitationId: GuestId,
  attemptId: GuestId,
  nonce: GuestSecret,
  state: Schema.Literals(["pending", "ready", "complete", "verified"]),
  mac: GuestSecret,
});

export const GuestChallenge = Schema.Struct({ epoch: GuestId, challenge: GuestSecret });

// Full snapshots also serve as bounded change events. A reconnect always omits after.
export const GUEST_CATALOG_LIMIT = 4096;
export const GUEST_CATALOG_BYTES = 8 * 1024 * 1024;
export const GuestSource = Schema.Struct({
  sourceTabId: PublicationTabId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  kind: Schema.Literals(["file", "plan", "folder"]),
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  artifact: Schema.optionalKey(Artifact),
  sourceVersion: Schema.optionalKey(Revision),
  permanent: Schema.optionalKey(Schema.Boolean),
});
export type GuestSource = typeof GuestSource.Type;
export const GuestCatalog = Schema.Struct({
  version: Schema.Literal(1),
  ownerDeviceId: GuestId,
  revision: Revision,
  sources: Schema.Array(GuestSource).check(Schema.isMaxLength(GUEST_CATALOG_LIMIT)),
});
export type GuestCatalog = typeof GuestCatalog.Type;
export const GuestCatalogRequest = Schema.Struct({ after: Schema.optionalKey(Revision) });
export const GuestContentRequest = Schema.Struct({
  sourceTabId: PublicationTabId,
  revision: Revision,
});
