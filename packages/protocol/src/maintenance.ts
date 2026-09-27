import { Schema } from "effect";

export const MAINTENANCE_TIMEOUT_MS = 120_000;
export const MAX_MAINTENANCE_TIMEOUT_MS = 600_000;
export const ShrinkRequest = Schema.Struct({
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_MAINTENANCE_TIMEOUT_MS }),
  ),
});
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const DatabaseBytes = Schema.Struct({ main: Bytes, wal: Bytes, allocated: Bytes });
export type DatabaseBytes = typeof DatabaseBytes.Type;
export const DatabaseShrink = Schema.Struct({
  database: Schema.Literals(["scope.db", "desktop.db", "hub.db"]),
  before: DatabaseBytes,
  after: DatabaseBytes,
  durationMs: Bytes,
  status: Schema.Literals(["completed", "skipped", "deferred", "failed"]),
  lastSuccess: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(32),
      Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    ),
  ),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  deferredBytes: Schema.optionalKey(Bytes),
});
export type DatabaseShrink = typeof DatabaseShrink.Type;
export const ShrinkReceipt = Schema.Struct({
  target: Schema.Literals(["desktop", "hub"]),
  databases: Schema.Array(DatabaseShrink).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export type ShrinkReceipt = typeof ShrinkReceipt.Type;

export const MaintenanceStatus = Schema.Struct({
  target: Schema.Literals(["desktop", "hub"]),
  databases: Schema.Array(DatabaseShrink).check(Schema.isMaxLength(2)),
});
export type MaintenanceStatus = typeof MaintenanceStatus.Type;
