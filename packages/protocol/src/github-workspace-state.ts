import * as Schema from "effect/Schema";

export const MAX_WORKSPACE_STATE_BYTES = 32 * 1024;

function isJSON(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(
        Boolean,
      ))
  )
    return false;
  return Object.values(value).every((item) => isJSON(item, depth + 1));
}

export const WorkspaceNodeStateObject = Schema.Unknown.check(
  Schema.makeFilter(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value) && isJSON(value, 0),
    {
      expected: "a JSON object with finite numbers and at most 32 nested levels",
      toJsonSchema: () => ({ type: "object", additionalProperties: true }),
    },
  ),
).pipe(Schema.decodeTo(Schema.JsonObject));

export const WorkspaceStateObject = WorkspaceNodeStateObject.check(
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_WORKSPACE_STATE_BYTES,
    {
      expected: "a JSON object within 32 KiB",
      toJsonSchema: () => ({ type: "object", additionalProperties: true }),
    },
  ),
);

export const WorkspaceNodeId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_=-]+$/),
);

const Version = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

export const WorkspaceNodeAppState = Schema.Struct({
  version: Version,
  value: WorkspaceNodeStateObject,
});
export type WorkspaceNodeAppState = typeof WorkspaceNodeAppState.Type;

export const WorkspaceNodeStateChange = Schema.Struct({
  nodeId: WorkspaceNodeId,
  operation: Schema.Literals(["set", "patch", "delete"]),
  version: Version,
});
export type WorkspaceNodeStateChange = typeof WorkspaceNodeStateChange.Type;

export const WorkspaceAppState = Schema.Struct({
  version: Version,
  value: WorkspaceStateObject,
});
export type WorkspaceAppState = typeof WorkspaceAppState.Type;

export const WorkspaceStateChange = Schema.Struct({
  operation: Schema.Literals(["set", "patch", "delete"]),
  ...WorkspaceAppState.fields,
});
export type WorkspaceStateChange = typeof WorkspaceStateChange.Type;
