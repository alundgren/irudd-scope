import { Schema } from "effect";
import { PublicationTabId } from "./index.ts";
import { RemoteId } from "./remote.ts";

/** Agent command routes. They accept the publishing token and hubs forward them live. */
export const FOLDER_COMMAND_ROUTES = {
  open: "/v1/folders/open",
  find: "/v1/folders/find",
  select: "/v1/folders/select",
  watch: "/v1/folders/watch",
} as const;
/** Hub file routes. Only the paired desktop's connection credential can use them. */
export const FOLDER_FILE_ROUTES = {
  list: "/v1/relay/folders/list",
  read: "/v1/relay/folders/read",
  events: "/v1/relay/folders/events",
  search: "/v1/relay/folders/search",
  write: "/v1/relay/folders/write",
} as const;
/** The relay capability a desktop advertises when it can receive folder commands. */
export const FOLDER_CAPABILITY = "folders";
/** File size of a byte-range read, sent as a response header. */
export const FOLDER_FILE_SIZE_HEADER = "Scope-Folder-File-Size";
/** Folder command bodies stay small; file bytes never travel on the artifact API. */
export const MAX_FOLDER_COMMAND_BYTES = 16 * 1024;
/** One directory listing returns at most this many entries and reports truncation. */
export const MAX_FOLDER_LISTING_ENTRIES = 50_000;
/** A change batch above this size is sent as `overflow`; readers reload open directories. */
export const MAX_FOLDER_CHANGES = 1000;
/** The events feed writes a heartbeat line at this interval to stay under socket timeouts. */
export const FOLDER_HEARTBEAT_MS = 10_000;
/**
 * Open `folder watch` streams per hub. They have their own count, separate from the 16
 * publication slots, so idle watches never block publishing.
 */
export const MAX_FOLDER_WATCHES = 16;

export const FOLDER_ERROR_CODES = [
  "no-tab",
  "not-found",
  "outside-folder",
  "not-a-directory",
  "unsupported",
  "desktop-offline",
] as const;
export const FolderErrorCode = Schema.Literals(FOLDER_ERROR_CODES);
export type FolderErrorCode = typeof FolderErrorCode.Type;
/** Every folder route failure is JSON with a code. A 404 without a code means an older Scope. */
export const FolderErrorBody = Schema.Struct({
  error: Schema.String.check(Schema.isMaxLength(2048)),
  code: FolderErrorCode,
});
export type FolderErrorBody = typeof FolderErrorBody.Type;

/** `local`, or the desktop's ID for the paired remote that has the files. */
export const MachineId = Schema.Union([Schema.Literal("local"), RemoteId]);
export type MachineId = typeof MachineId.Type;

/** An absolute path on the machine that has the files. */
export const FolderPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  // oxlint-disable-next-line no-control-regex -- Paths must not contain NUL.
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\u0000]*$/),
);
export type FolderPath = typeof FolderPath.Type;

/**
 * A path inside a folder, with `/` separators and no `.` or `..` segments.
 * The empty string is the folder itself.
 */
export const FolderRelativePath = Schema.String.check(
  Schema.isMaxLength(4096),
  // oxlint-disable-next-line no-control-regex -- Relative paths exclude NUL, backslashes, and empty segments.
  Schema.isPattern(/^(?:[^/\\\u0000]+(?:\/[^/\\\u0000]+)*)?$/),
  Schema.makeFilter((value) => value.split("/").every((part) => part !== "." && part !== ".."), {
    expected: "a path inside the folder",
    toJsonSchema: () => ({ type: "string" }),
  }),
);
export type FolderRelativePath = typeof FolderRelativePath.Type;

export const FolderTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));

/** The key of a Folder tab: one tab per machine and canonical path. */
export const FolderIdentity = Schema.Struct({ machineId: MachineId, path: FolderPath });
export type FolderIdentity = typeof FolderIdentity.Type;

// `machine` is accepted so older or crafted callers do not fail; Scope ignores it and
// uses the connection that delivered the command.
const IgnoredMachine = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64)));

export const FolderOpenRequest = Schema.Struct({
  path: FolderPath,
  title: Schema.optionalKey(FolderTitle),
  machine: IgnoredMachine,
});
export type FolderOpenRequest = typeof FolderOpenRequest.Type;
export const FolderOpenReceipt = Schema.Struct({
  tabId: PublicationTabId,
  machine: MachineId,
  path: FolderPath,
  created: Schema.Boolean,
});
export type FolderOpenReceipt = typeof FolderOpenReceipt.Type;

export const FolderFindRequest = Schema.Struct({ path: FolderPath, machine: IgnoredMachine });
export type FolderFindRequest = typeof FolderFindRequest.Type;
/** A trashed tab counts as not open. */
export const FolderFindReceipt = Schema.Struct({
  open: Schema.Boolean,
  tabId: Schema.optionalKey(PublicationTabId),
  machine: MachineId,
  path: FolderPath,
});
export type FolderFindReceipt = typeof FolderFindReceipt.Type;

export const FolderSelectRequest = Schema.Struct({
  path: FolderPath,
  file: FolderRelativePath.check(Schema.isMinLength(1)),
  title: Schema.optionalKey(FolderTitle),
  machine: IgnoredMachine,
});
export type FolderSelectRequest = typeof FolderSelectRequest.Type;
export const FolderSelectReceipt = Schema.Struct({
  ...FolderOpenReceipt.fields,
  file: FolderRelativePath,
});
export type FolderSelectReceipt = typeof FolderSelectReceipt.Type;

/** `GET /v1/folders/watch?path=` prints one JSON line per event. */
export const FolderDropEvent = Schema.Struct({
  type: Schema.Literal("dropped"),
  paths: Schema.Array(FolderRelativePath).check(Schema.isMinLength(1)),
});
export type FolderDropEvent = typeof FolderDropEvent.Type;
export const FolderWatchEvent = Schema.Union([
  FolderDropEvent,
  Schema.Struct({ type: Schema.Literal("closed") }),
  Schema.Struct({ type: Schema.Literal("heartbeat") }),
]);
export type FolderWatchEvent = typeof FolderWatchEvent.Type;

export const FolderEntry = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  path: FolderRelativePath,
  kind: Schema.Literals(["file", "directory", "symlink", "other"]),
  /** For symlinks: whether the target stays inside the folder. Outside targets are never followed. */
  link: Schema.optionalKey(Schema.Literals(["inside", "outside", "broken"])),
  size: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  modifiedAt: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
  ignored: Schema.Boolean,
});
export type FolderEntry = typeof FolderEntry.Type;
/** Directories sort before files, then by name. */
export const FolderListing = Schema.Struct({
  path: FolderRelativePath,
  entries: Schema.Array(FolderEntry),
  truncated: Schema.Boolean,
});
export type FolderListing = typeof FolderListing.Type;

const ChangedPath = Schema.Struct({
  type: Schema.Literals(["created", "deleted", "changed"]),
  path: FolderRelativePath,
});
/**
 * A change inside a folder. Renames may arrive as `deleted` and `created`. A `created`
 * directory can already contain files that have no change of their own, so readers that
 * track every path list a new directory themselves.
 */
export const FolderChange = Schema.Union([
  ChangedPath,
  Schema.Struct({
    type: Schema.Literal("renamed"),
    from: FolderRelativePath,
    to: FolderRelativePath,
  }),
]);
export type FolderChange = typeof FolderChange.Type;

/** One NDJSON line of `GET /v1/relay/folders/events` and of the desktop's local change feed. */
export const FolderFeedEvent = Schema.Union([
  /** The folder's state: `live` is false while changes are found by polling. */
  Schema.Struct({ type: Schema.Literal("status"), exists: Schema.Boolean, live: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("changes"),
    changes: Schema.Array(FolderChange).check(Schema.isMaxLength(MAX_FOLDER_CHANGES)),
    /** Too many changes to list: reload every open directory. */
    overflow: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("heartbeat") }),
]);
export type FolderFeedEvent = typeof FolderFeedEvent.Type;

/** Query of `GET /v1/relay/folders/list`. */
export const FolderListQuery = Schema.Struct({
  root: FolderPath,
  path: FolderRelativePath,
  showIgnored: Schema.Boolean,
});
export type FolderListQuery = typeof FolderListQuery.Type;
/** Query of `GET /v1/relay/folders/read`: bytes `start` up to but not including `end`. */
export const FolderReadQuery = Schema.Struct({
  root: FolderPath,
  path: FolderRelativePath.check(Schema.isMinLength(1)),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type FolderReadQuery = typeof FolderReadQuery.Type;

export const FolderSearchRequest = Schema.Struct({
  root: FolderPath,
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  showIgnored: Schema.Boolean,
});
export type FolderSearchRequest = typeof FolderSearchRequest.Type;
/** One NDJSON line of `POST /v1/relay/folders/search`. */
export const FolderSearchEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("match"),
    path: FolderRelativePath,
    line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    text: Schema.String.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({ type: Schema.Literal("done"), truncated: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("heartbeat") }),
]);
export type FolderSearchEvent = typeof FolderSearchEvent.Type;

/** Query of `PUT /v1/relay/folders/write`; the body is the raw file. */
export const FolderWriteQuery = Schema.Struct({
  root: FolderPath,
  path: FolderRelativePath.check(Schema.isMinLength(1)),
  replace: Schema.Boolean,
});
export type FolderWriteQuery = typeof FolderWriteQuery.Type;
export const FolderWriteReceipt = Schema.Struct({
  path: FolderRelativePath,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type FolderWriteReceipt = typeof FolderWriteReceipt.Type;

/** The typed JSON body for a failed folder request. */
export function folderErrorBody(error: unknown, fallback: FolderErrorCode): FolderErrorBody {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  return {
    error: (error instanceof Error ? error.message : "The folder request failed.").slice(0, 2048),
    code: FOLDER_ERROR_CODES.find((value) => value === code) ?? fallback,
  };
}

/** Encodes a file route query. Booleans are `1` or `0`. */
export function folderQuery(values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined)
      query.set(name, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  return query.toString();
}

/** Reads a file route query into the values its schema expects; validate the result. */
export function readFolderQuery(
  query: URLSearchParams,
  types: Record<string, "string" | "number" | "boolean">,
) {
  const values: Record<string, string | number | boolean> = {};
  for (const [name, value] of query) {
    if (name in values || !Object.hasOwn(types, name))
      throw new Error(`Unexpected query parameter: ${name}.`);
    const type = types[name];
    values[name] =
      type === "number"
        ? /^\d{1,16}$/.test(value)
          ? Number(value)
          : Number.NaN
        : type === "boolean"
          ? value === "1"
            ? true
            : value === "0"
              ? false
              : value
          : value;
  }
  return values;
}

export function folderCommandRequest(method: string, path: string): boolean {
  if (method === "GET") return path.startsWith(`${FOLDER_COMMAND_ROUTES.watch}?`);
  return (
    method === "POST" &&
    [FOLDER_COMMAND_ROUTES.open, FOLDER_COMMAND_ROUTES.find, FOLDER_COMMAND_ROUTES.select].some(
      (route) => route === path,
    )
  );
}

export const FolderGuide = {
  purpose:
    "Share an agent's working folder as a Folder tab in Scope. Open a folder only when the person asks.",
  commands: {
    open: "irudd-scope folder open [PATH] [--title TITLE]",
    find: "irudd-scope folder find [PATH]",
    select: "irudd-scope folder select PATH FILE [--title TITLE]",
    watch: "irudd-scope folder watch [PATH]",
  },
  receipt:
    "open and select print JSON with tabId, machine (local or the remote ID), the canonical path, and created; select adds file. find prints open, tabId when open, machine, and path.",
  rules: [
    'Pass a short --title naming the task, such as --title "Login fix". Without it the tab uses the folder name.',
    "Opening the same folder again returns the same tab with created: false, renames it when --title changes, and restores it from Trashcan.",
    "Scope never switches the selected tab for an agent command. The Folder tab is marked unread.",
    "find reports open: false, and exits 0, when the folder has no tab or its tab is closed or in Trashcan.",
    "To show the person a file, usually the one you just wrote, run one select command. FILE is relative to PATH. It opens the tab when needed, expands the folders down to the file, and selects it.",
    'watch prints one JSON line per event and keeps running. It prints {"type":"closed"} and exits 0 when the person closes the tab. It fails when the folder has no open tab or Scope disconnects.',
    "On a paired remote the command goes through the hub. It fails when the desktop is not connected and is never queued.",
    "Scope reads files only inside the folder and keeps no copy of them.",
  ],
} as const;
