import { Schema } from "effect";
import { RemoteId, RemoteName, type HubUpdateStatus } from "@irudd-scope/protocol/remote";

export const Remote = Schema.Struct({
  id: RemoteId,
  name: RemoteName,
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  enabled: Schema.Boolean,
});
export type Remote = typeof Remote.Type;
export const Remotes = Schema.Array(Remote);
export type RemoteStatus = Remote & {
  connection: "connecting" | "connected" | "disconnected" | "error";
  message: string;
  update?: HubUpdateStatus;
};
