import { Schema } from "effect";
import { TransferId } from "@irudd-scope/protocol/transfer";

export const GuestAccess = Schema.Struct({ peerId: TransferId, enabled: Schema.Boolean });
export type GuestPeerStatus = {
  peerId: string;
  enabled: boolean;
  state: "disabled" | "setup" | "connecting" | "connected" | "offline" | "update-required";
  message?: string;
};
export type GuestStatus = {
  peers: GuestPeerStatus[];
  credentialStorage: "keychain" | "windows" | "session";
};

export const GuestSettings = Schema.Struct({
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  enabled: Schema.Record(Schema.String, Schema.Boolean),
});
export type GuestSettings = typeof GuestSettings.Type;
