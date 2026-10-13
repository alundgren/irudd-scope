import { Schema } from "effect";
import { MemoryRepository } from "@irudd-scope/protocol/memory";

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
export const MemoryTabState = Schema.Union([
  LegacyMemoryTabState,
  Schema.Struct({
    version: Schema.Literal(2),
    data: Schema.Struct({
      recovery: Schema.optionalKey(LegacyMemoryTabState.fields.data),
      original: Schema.optionalKey(LegacyMemoryTabState),
    }),
  }),
]);
export const memoryTabContract = {
  type: "memory",
  category: "builtin" as const,
  version: 2,
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
export const MemoryConcept = Schema.Struct({
  ...Summary.fields,
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
