import { Schema } from "effect";
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
