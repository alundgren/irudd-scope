import { Schema } from "effect";
import { GuestFolderWrite } from "@irudd-scope/protocol/guest-folder";
import { FolderOperationStatus } from "@irudd-scope/protocol/folder-operation";
import { FolderIdentity } from "@irudd-scope/protocol/folder";
import { TransferId } from "@irudd-scope/protocol/transfer";

export const GuestFolderOriginal = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  dev: Schema.Number,
  ino: Schema.Number,
});
export type GuestFolderOriginal = typeof GuestFolderOriginal.Type;
export const GuestFolderPending = Schema.Struct({
  guestId: TransferId,
  write: GuestFolderWrite,
  original: Schema.optionalKey(GuestFolderOriginal),
  outcome: Schema.optionalKey(FolderOperationStatus),
});
export type GuestFolderPending = typeof GuestFolderPending.Type;
export const GuestFolderBinding = Schema.Struct({
  caller: TransferId,
  write: GuestFolderWrite,
  identity: FolderIdentity,
});
export type GuestFolderBinding = typeof GuestFolderBinding.Type;
