import { Schema } from "effect";
import { MemoryRepository } from "@irudd-scope/protocol/memory";
import { MemoryActor } from "@irudd-scope/protocol/librarian";

export const MemoryPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !/[\\\x00-\x1f]/.test(value) &&
      value.endsWith(".md") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    { expected: "a relative Markdown path" },
  ),
);
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Text = Schema.String.check(Schema.isMaxLength(1_000_000));
const Label = Schema.String.check(Schema.isMaxLength(4096));
export const MemoryDraft = Schema.Struct({
  repository: MemoryRepository,
  path: MemoryPath,
  expectedHash: Hash,
  raw: Text,
});
export type MemoryDraft = typeof MemoryDraft.Type;
export const LegacyMemoryTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    path: Schema.optionalKey(MemoryPath),
    mode: Schema.optionalKey(Schema.Literals(["wiki", "graph"])),
    draft: Schema.optionalKey(MemoryDraft),
  }),
});
const RecoveredData = {
  recovery: Schema.optionalKey(LegacyMemoryTabState.fields.data),
  original: Schema.optionalKey(LegacyMemoryTabState),
};
const Position = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export const MemoryPositions = Schema.Struct({
  browse: Schema.optionalKey(Position),
  memory: Schema.optionalKey(Position),
  connections: Schema.optionalKey(Position),
  stages: Schema.optionalKey(Position),
  activity: Schema.optionalKey(Position),
  machines: Schema.optionalKey(Position),
});
export type MemoryPositions = typeof MemoryPositions.Type;
export const MemoryTabState = Schema.Union([
  LegacyMemoryTabState,
  Schema.Struct({ version: Schema.Literal(2), data: Schema.Struct(RecoveredData) }),
  // Written only once a scroll position is saved, so untouched tabs stay readable by older builds.
  Schema.Struct({
    version: Schema.Literal(3),
    data: Schema.Struct({ ...RecoveredData, positions: Schema.optionalKey(MemoryPositions) }),
  }),
]);
export type MemoryTabState = typeof MemoryTabState.Type;
export const memoryTabContract = {
  type: "memory",
  category: "builtin" as const,
  version: 3,
  state: MemoryTabState,
};
export const memoryTabState = () => ({ version: 2, data: {} });

const Summary = Schema.Struct({
  bundle: Schema.Literal("personal"),
  path: MemoryPath,
  title: Label,
  type: Schema.NullOr(Label),
  description: Label,
  tags: Schema.Array(Label).check(Schema.isMaxLength(1000)),
  hash: Hash,
  malformed: Schema.Boolean,
  memory: Schema.optionalKey(Schema.Unknown),
});
export const MemorySummary = Summary;
export type MemorySummary = typeof Summary.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const MemoryChangeSummary = Schema.Struct({
  id: Label,
  path: Label,
  title: Schema.optionalKey(Label),
  action: Schema.Literals(["create", "update", "delete"]),
  status: Schema.Literals(["pending", "accepted", "rejected", "superseded"]),
  createdAt: Label,
  actor: MemoryActor,
  decidedBy: Schema.Array(
    Schema.Struct({
      actor: MemoryActor,
      decision: Schema.Literals(["accept", "reject"]),
      at: Label,
    }),
  ),
  reason: Label,
  stageChange: Schema.optionalKey(Schema.Struct({ from: Label, to: Label })),
});
export type MemoryChangeSummary = typeof MemoryChangeSummary.Type;
export const MemoryChanges = Schema.Struct({
  items: Schema.Array(MemoryChangeSummary).check(Schema.isMaxLength(20)),
  scanned: Count,
  total: Count,
  partial: Schema.Boolean,
});
export type MemoryChanges = typeof MemoryChanges.Type;
export const MemoryConcept = Schema.Struct({
  ...Summary.fields,
  changes: Schema.optionalKey(MemoryChanges),
  raw: Text,
  body: Text,
  metadata: Schema.optionalKey(Schema.Unknown),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  links: Schema.Array(
    Schema.Struct({
      target: Label,
      label: Label,
      external: Schema.Boolean,
      broken: Schema.Boolean,
      fragment: Schema.optionalKey(Label),
    }),
  ).check(Schema.isMaxLength(10000)),
  backlinks: Schema.Array(
    Schema.Struct({ bundle: Schema.Literal("personal"), path: MemoryPath, title: Label }),
  ).check(Schema.isMaxLength(10000)),
});
export type MemoryConcept = typeof MemoryConcept.Type;
export const MemorySearch = Schema.Struct({
  version: Schema.Literal(1),
  query: Schema.String,
  results: Schema.Array(
    Schema.Struct({
      ...Summary.fields,
      excerpt: Label,
      score: Schema.optionalKey(Schema.Number),
      matched: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ).check(Schema.isMaxLength(30)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Literal(30),
  truncated: Schema.Boolean,
});
export type MemorySearch = typeof MemorySearch.Type;

/** `irudd-okf list`: every concept summary with its memory metadata, without paging. */
export const MemoryList = Schema.Struct({
  version: Schema.Literal(1),
  concepts: Schema.Array(Summary),
});
const Facet = Schema.Struct({ value: Label, count: Count });
export const MemoryFacets = Schema.Struct({
  tags: Schema.Array(Facet).check(Schema.isMaxLength(50)),
  tagTotal: Count,
  kinds: Schema.Array(Facet),
  stages: Schema.Array(Facet),
  applicability: Schema.Array(Facet),
  unavailable: Schema.optionalKey(Label),
});
export type MemoryFacets = typeof MemoryFacets.Type;
/** A page of the library narrowed by filters, optionally intersected with text search. */
export const MemoryListPage = Schema.Struct({
  version: Schema.Literal(1),
  filtered: Schema.Literal(true),
  query: Schema.String,
  results: Schema.Array(
    Schema.Struct({ ...Summary.fields, excerpt: Schema.optionalKey(Label) }),
  ).check(Schema.isMaxLength(30)),
  total: Count,
  offset: Count,
  limit: Schema.Literal(30),
  truncated: Schema.Boolean,
  searchLimited: Schema.optionalKey(Schema.Struct({ scanned: Count, total: Count })),
});
export type MemoryListPage = typeof MemoryListPage.Type;

export type MemoryFields = {
  kind?: string;
  stage?: string;
  applicability?: { type: string; id?: string };
  humanReviewed?: boolean;
  trustTier?: string;
  archived?: boolean;
  deprecated?: boolean;
};
/** Reads the optional memory metadata irudd-okf attaches, ignoring values of unexpected types. */
export function memoryFields(value: unknown): MemoryFields {
  if (!value || typeof value !== "object") return {};
  const memory = value as Record<string, unknown>;
  const text = (key: string) => (typeof memory[key] === "string" ? memory[key] : undefined);
  const flag = (key: string) => (typeof memory[key] === "boolean" ? memory[key] : undefined);
  const scope = memory.applicability as Record<string, unknown> | undefined;
  return {
    kind: text("kind"),
    stage: text("stage"),
    applicability:
      scope && typeof scope.type === "string"
        ? { type: scope.type, ...(typeof scope.id === "string" ? { id: scope.id } : {}) }
        : undefined,
    humanReviewed: flag("humanReviewed"),
    trustTier: text("trustTier"),
    archived: flag("archived"),
    deprecated: flag("deprecated"),
  };
}
