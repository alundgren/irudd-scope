import { Schema } from "effect";
import { GuestAddress, GuestSource } from "@irudd-scope/protocol/guest";
import { Tab } from "../workspace/contract.ts";
import { TransferId } from "@irudd-scope/protocol/transfer";

export const GuestAccess = Schema.Struct({ peerId: TransferId, enabled: Schema.Boolean });
export type GuestPeerStatus = {
  peerId: string;
  enabled: boolean;
  state:
    | "disabled"
    | "setup"
    | "connecting"
    | "connected"
    | "offline"
    | "access-denied"
    | "update-required";
  message?: string;
};
export type GuestStatus = {
  peers: GuestPeerStatus[];
  credentialStorage: "keychain" | "windows" | "session";
};

export const GuestSettings = Schema.Struct({
  address: Schema.optionalKey(GuestAddress),
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  enabled: Schema.Record(Schema.String, Schema.Boolean),
});
export type GuestSettings = typeof GuestSettings.Type;

export const GuestTabState = Schema.Struct({ version: Schema.Literal(1), data: Schema.JsonObject });
export const GuestRecord = Schema.Struct({
  ownerDeviceId: TransferId,
  source: GuestSource,
  tab: Tab,
});
export type GuestRecord = typeof GuestRecord.Type;
export type GuestCatalogView = {
  records: readonly GuestRecord[];
  owners: readonly {
    deviceId: string;
    name: string;
    mutations?: boolean;
    state: GuestPeerStatus["state"] | "forgotten";
    message?: string;
  }[];
  available: readonly string[];
};
