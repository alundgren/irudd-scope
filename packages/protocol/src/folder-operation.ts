import { Schema } from "effect";
import { FolderRelativePath, FolderWriteReceipt, FolderErrorBody } from "./folder.ts";

export const FOLDER_OPERATION_CAPABILITY = "folder-operations-v1";
export const FOLDER_OPERATION_ROUTES = {
  capabilities: "/v1/relay/folders/capabilities",
  version: "/v1/relay/folders/version",
  execute: "/v1/relay/folders/operations",
  status: "/v1/relay/folders/operation-status",
} as const;
export const FOLDER_OPERATION_RETENTION_MS = 48 * 60 * 60_000;
export const MAX_FOLDER_OPERATIONS = 4096;
export const FOLDER_UPLOAD_IDLE_MS = 60_000;
export const FOLDER_UPLOAD_TOTAL_MS = 12 * 60 * 60_000;
export const FolderOperationCapabilities = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  retentionMs: Schema.Int,
  maxOperations: Schema.Int,
});
export const FolderVersionReceipt = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^(?:missing|[0-9a-f]{64})$/)),
});
export const FolderOperationCaller = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
/** Creation time in epoch milliseconds, a colon, and a UUID. Never change an uncertain ID. */
export const FolderOperationId = Schema.String.check(
  Schema.isPattern(/^\d{13}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export const FolderFileVersion = Schema.String.check(
  Schema.isPattern(/^(?:missing|[0-9a-f]{64})$/),
);
export const FolderPayload = Schema.Struct({
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type FolderPayload = typeof FolderPayload.Type;
export const FolderOperationRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestId: FolderOperationId,
  path: FolderRelativePath.check(Schema.isMinLength(1)),
  kind: Schema.Literals(["file", "directory"]),
  expectedVersion: FolderFileVersion,
  replace: Schema.Boolean,
  payload: FolderPayload,
}).check(
  Schema.makeFilter(
    (value) =>
      value.kind === "file"
        ? value.replace === (value.expectedVersion !== "missing")
        : !value.replace &&
          value.expectedVersion === "missing" &&
          value.payload.size === 0 &&
          value.payload.sha256 ===
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    { expected: "explicit replacement consent and an expected version, or exclusive creation" },
  ),
);
export type FolderOperationRequest = typeof FolderOperationRequest.Type;
export const FolderOperationStatus = Schema.Struct({
  requestId: FolderOperationId,
  state: Schema.Literals(["unknown", "pending", "completed", "failed", "unresolved", "expired"]),
  expiresAt: Schema.Int,
  receipt: Schema.optionalKey(FolderWriteReceipt),
  error: Schema.optionalKey(FolderErrorBody),
});
export type FolderOperationStatus = typeof FolderOperationStatus.Type;
