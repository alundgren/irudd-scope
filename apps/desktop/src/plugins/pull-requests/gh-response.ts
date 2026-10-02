import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { GitHubReadError } from "./gh-process.ts";

export const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

export function json(output: string): unknown {
  try {
    const value: unknown = JSON.parse(output);
    if (value && typeof value === "object" && "errors" in value) {
      const errors = value.errors;
      if (!Array.isArray(errors) || errors.length)
        throw new GitHubReadError("GitHub could not return a complete result. Try Sync again.");
    }
    return value;
  } catch (error) {
    if (error instanceof GitHubReadError) throw error;
    throw new GitHubReadError("GitHub returned invalid data. The saved list was kept.");
  }
}

export function validated<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return decode(schema, value);
  } catch {
    throw new GitHubReadError("GitHub returned invalid data. The saved list was kept.");
  }
}

export function githubValue<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(value);
  } catch {
    throw new GitHubReadError("GitHub returned invalid data. The saved list was kept.");
  }
}

export function nextCursor(info: typeof PageInfo.Type, seen: Set<string>): string | null {
  if (!info.hasNextPage) return null;
  if (!info.endCursor || seen.has(info.endCursor))
    throw new GitHubReadError("GitHub pagination did not advance. The saved list was kept.");
  seen.add(info.endCursor);
  return info.endCursor;
}
