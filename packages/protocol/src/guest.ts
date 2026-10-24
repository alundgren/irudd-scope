import { Schema } from "effect";
import { Artifact, PublicationTabId, Revision } from "./index.ts";
import { TransferId, TransferName, TransferSecret, TailcatAddress } from "./transfer.ts";

export const GUEST_VERSION = 1;
export const GuestEndpoint = Schema.Struct({
  address: TailcatAddress.check(Schema.isMaxLength(255)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type GuestEndpoint = typeof GuestEndpoint.Type;
export const GuestHello = Schema.Struct({
  version: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  pairId: TransferId,
  deviceId: TransferId,
  targetId: TransferId,
  name: TransferName,
  nonce: TransferSecret,
  epoch: TransferId,
  targetEpoch: TransferId,
  challenge: TransferSecret,
  enabled: Schema.Boolean,
  capabilities: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))).check(
    Schema.isMaxLength(32),
  ),
  endpoint: GuestEndpoint,
  timestamp: Schema.Int,
});
export type GuestHello = typeof GuestHello.Type;
export const GuestProof = Schema.Struct({ hello: GuestHello, mac: TransferSecret });
export const GuestReply = Schema.Struct({
  hello: GuestHello,
  requestNonce: TransferSecret,
  session: TransferSecret,
  mac: TransferSecret,
});
export const GuestLink = Schema.Struct({
  version: Schema.Literal(1),
  pairId: TransferId,
  deviceId: TransferId,
  targetId: TransferId,
  endpoint: GuestEndpoint,
  expiresAt: Schema.Int,
  mac: TransferSecret,
});

export const GuestChallenge = Schema.Struct({ epoch: TransferId, challenge: TransferSecret });

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
  ownerDeviceId: TransferId,
  revision: Revision,
  sources: Schema.Array(GuestSource).check(Schema.isMaxLength(GUEST_CATALOG_LIMIT)),
});
export type GuestCatalog = typeof GuestCatalog.Type;
export const GuestCatalogRequest = Schema.Struct({ after: Schema.optionalKey(Revision) });
export const GuestContentRequest = Schema.Struct({
  sourceTabId: PublicationTabId,
  revision: Revision,
});
