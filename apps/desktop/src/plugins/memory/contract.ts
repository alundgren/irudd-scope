import { Schema } from "effect";
import { MemoryRepository } from "@irudd-scope/protocol/memory";
import { Uuid } from "../../workspace/contract.ts";

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
export const MemoryTabState = Schema.Struct({
  version: Schema.Literal(1),
  data: Schema.Struct({
    path: Schema.optionalKey(MemoryPath),
    mode: Schema.optionalKey(Schema.Literals(["wiki", "graph"])),
    draft: Schema.optionalKey(MemoryDraft),
  }),
});
export const memoryTabContract = {
  type: "memory",
  category: "builtin" as const,
  version: 1,
  state: MemoryTabState,
};
export const memoryTabState = () => ({ version: 1, data: {} });

const Request = { tabId: Uuid, repository: MemoryRepository };
export const MemoryCommand = Schema.Union([
  Schema.Struct({ ...Request, action: Schema.Literal("read"), path: MemoryPath }),
  Schema.Struct({
    ...Request,
    action: Schema.Literal("search"),
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100000)),
  }),
  Schema.Struct({
    ...Request,
    action: Schema.Literal("graph"),
    path: Schema.optionalKey(MemoryPath),
  }),
  Schema.Struct({ ...Request, action: Schema.Literal("save"), ...MemoryDraft.fields }),
]);
export type MemoryCommand = typeof MemoryCommand.Type;
const Summary = Schema.Struct({
  bundle: Schema.Literal("personal"),
  path: MemoryPath,
  title: Label,
  type: Schema.NullOr(Label),
  description: Label,
  tags: Schema.Array(Label).check(Schema.isMaxLength(1000)),
  hash: Hash,
  malformed: Schema.Boolean,
});
export const MemoryConcept = Schema.Struct({
  ...Summary.fields,
  raw: Text,
  body: Text,
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
  results: Schema.Array(Schema.Struct({ ...Summary.fields, excerpt: Label })).check(
    Schema.isMaxLength(30),
  ),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Literal(30),
  truncated: Schema.Boolean,
});
export type MemorySearch = typeof MemorySearch.Type;
export const MemoryGraph = Schema.Struct({
  version: Schema.Literal(1),
  nodes: Schema.Array(Summary).check(Schema.isMaxLength(80)),
  edges: Schema.Array(
    Schema.Struct({
      from: Label,
      to: Label,
      label: Label,
      broken: Schema.Boolean,
      external: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(10000)),
  truncated: Schema.Boolean,
  limit: Schema.Int,
});
export type MemoryGraph = typeof MemoryGraph.Type;
export const MemorySaved = Schema.Struct({
  version: Schema.Literal(1),
  bundle: Schema.Literal("personal"),
  path: MemoryPath,
  hash: Hash,
  changedPaths: Schema.Array(MemoryPath),
});
export type MemoryReply =
  | { action: "read"; concept: MemoryConcept }
  | { action: "search"; search: MemorySearch }
  | { action: "graph"; graph: MemoryGraph }
  | { action: "save"; hash: string }
  | { action: "error"; code: string; message: string };
