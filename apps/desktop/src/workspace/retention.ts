import { Schema } from "effect";
import { Tab, Uuid } from "./contract.ts";

export const TEMPORARY_RETENTION_MS = 24 * 60 * 60_000;
export const TRASH_RETENTION_MS = 7 * TEMPORARY_RETENTION_MS;
const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RetainedTab = Schema.Struct({
  tab: Tab,
  permanent: Schema.Boolean,
  lastVisibleAt: Timestamp,
  trashedAt: Schema.NullOr(Timestamp),
});
export type RetainedTab = typeof RetainedTab.Type;

export const TrashEntry = Schema.Struct({ id: Uuid, trashedAt: Timestamp });
export type TrashEntry = typeof TrashEntry.Type;
