import { Schema } from "effect";
import { TransferId, TransferName, TransferSecret } from "@irudd-scope/protocol/transfer";
import type { Artifact } from "@irudd-scope/protocol";

export const ScopePeer = Schema.Struct({
  id: TransferId,
  deviceId: TransferId,
  name: TransferName,
  createdAt: Schema.Int,
});
export type ScopePeer = typeof ScopePeer.Type;
export const ScopePeers = Schema.Array(ScopePeer);
export const ScopeDevice = Schema.Struct({ deviceId: TransferId, name: TransferName });
export type ScopeDevice = typeof ScopeDevice.Type;
export type TransferDevices = ScopeDevice & {
  peers: ScopePeer[];
  credentialStorage: "keychain" | "session";
};
export type TransferStatus = {
  id: string;
  url: string;
  expiresAt: number;
  state: "waiting" | "paired" | "importing" | "delivered" | "expired" | "cancelled";
};
export type TransferPreview = {
  id: string;
  title: string;
  kind: string;
  fileName: string;
  size: number;
  sourceName: string;
  expiresAt: number;
  alreadyImported?: boolean;
};
export type TransferImport = { artifact: Artifact; alreadyImported: boolean };
export const PairScopeInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(8192)),
  secret: TransferSecret,
  name: TransferName,
});
export const SendTabInput = Schema.Struct({ tabId: TransferId, peerId: TransferId });
