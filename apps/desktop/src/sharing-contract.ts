import { Schema } from "effect";
import { Share, SharingId } from "@irudd-scope/protocol/sharing";

export const SharingDestination = Schema.Struct({
  id: SharingId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  shares: Schema.Array(Share).check(Schema.isMaxLength(128)),
  pendingStops: Schema.Array(SharingId).check(Schema.isMaxLength(128)),
  removing: Schema.Boolean,
});
export type SharingDestination = typeof SharingDestination.Type;
export const SharingDestinations = Schema.Array(SharingDestination).check(Schema.isMaxLength(32));
export type SharingView = SharingDestination & { connected: boolean; message?: string };
export const activeShare = (share: Share) =>
  share.status === "starting" || share.status === "active";
