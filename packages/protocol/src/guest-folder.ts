import { Schema } from "effect";
import { Revision } from "./index.ts";
import { GuestTarget } from "./guest-operation.ts";
import { FolderRelativePath, FolderSearchRequest } from "./folder.ts";
import { FolderOperationRequest, FolderOperationId } from "./folder-operation.ts";

export const GUEST_FOLDER_HEADER = "scope-guest-folder";
export const GUEST_FOLDER_ROUTES = {
  list: "folder-read-v1",
  read: "folder-read-v1",
  events: "folder-read-v1",
  search: "folder-read-v1",
  info: "folder-read-v1",
  version: "folder-version-v1",
  upload: "folder-write-v1",
  directory: "folder-directory-v1",
  status: "folder-status-v1",
} as const;
export type GuestFolderRoute = keyof typeof GUEST_FOLDER_ROUTES;
export const GuestFolderTarget = Schema.Struct({
  target: GuestTarget,
  sourceVersion: Revision,
});
export const GuestFolderPath = Schema.Struct({
  ...GuestFolderTarget.fields,
  path: FolderRelativePath,
});
export const GuestFolderList = Schema.Struct({
  ...GuestFolderPath.fields,
  showIgnored: Schema.Boolean,
});
export const GuestFolderRead = Schema.Struct({
  ...GuestFolderPath.fields,
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const GuestFolderSearch = Schema.Struct({
  ...GuestFolderTarget.fields,
  names: FolderSearchRequest.fields.names,
  query: FolderSearchRequest.fields.query,
  showIgnored: Schema.Boolean,
});
export const GuestFolderWrite = Schema.Struct({
  ...GuestFolderTarget.fields,
  operation: FolderOperationRequest,
});
export type GuestFolderWrite = typeof GuestFolderWrite.Type;
export const GuestFolderStatus = Schema.Struct({
  target: GuestTarget,
  requestId: FolderOperationId,
});
export const GuestFolderInfo = Schema.Struct({
  machine: Schema.String.check(Schema.isMaxLength(160)),
});
