import * as Schema from "effect/Schema";

export const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
export const MAX_METADATA_BYTES = 16 * 1024;
export const DEFAULT_PORT = 43120;
export const DEFAULT_CONNECTION_FILE = ".config/irudd-scope/desktop.json";

export const LocalConnection = Schema.Struct({
  version: Schema.Literal(1),
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  token: Schema.String.check(
    Schema.isMinLength(24),
    Schema.isMaxLength(2048),
    Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
  ),
});
export type LocalConnection = typeof LocalConnection.Type;

export function decodeLocalConnection(input: unknown): LocalConnection {
  try {
    const connection = decode(LocalConnection, input);
    const endpoint = validateEndpoint(connection.endpoint);
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw new Error("Expected a local endpoint.");
    return { ...connection, endpoint };
  } catch {
    throw new Error(
      "Invalid local Scope connection file. Restore it or remove it with Scope closed.",
    );
  }
}

export const ArtifactId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
);
export const ArtifactName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,127}$/));
export const BlobId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ArtifactKind = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
export type ArtifactKind = typeof ArtifactKind.Type;
const ShortText = Schema.String.check(Schema.isMaxLength(512));
export const Source = Schema.Struct({
  host: Schema.optionalKey(ShortText),
  agent: Schema.optionalKey(ShortText),
  repo: Schema.optionalKey(ShortText),
  worktree: Schema.optionalKey(ShortText),
  branch: Schema.optionalKey(ShortText),
  sessionId: Schema.optionalKey(ShortText),
  cwd: Schema.optionalKey(ShortText),
});
export type Source = typeof Source.Type;
export const Revision = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Fields = {
  name: Schema.optionalKey(ArtifactName),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  kind: ArtifactKind,
  blob: BlobId,
  fileName: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(255),
    // oxlint-disable-next-line no-control-regex -- Download filenames must exclude control characters.
    Schema.isPattern(/^[^/\\\u0000-\u001f]+$/),
  ),
  mediaType: Schema.String.check(
    Schema.isPattern(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
    Schema.isMaxLength(128),
  ),
  source: Schema.optionalKey(Source),
};
export const PublicationTabId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export const PublicationRequest = Schema.Struct({ expectedRevision: Revision });
export const PublicationReceipt = Schema.Struct({ tabId: PublicationTabId });
export const ArtifactWrite = Schema.Struct({
  ...Fields,
  expectedRevision: Revision,
  tabId: PublicationTabId,
});
export type ArtifactWrite = typeof ArtifactWrite.Type;
export const Artifact = Schema.Struct({
  ...Fields,
  id: ArtifactId,
  revision: Revision,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CONTENT_BYTES })),
});
export type Artifact = typeof Artifact.Type;
export const MAX_BUFFERED_TABS = 50;
export const BUFFERED_TAB_TTL_MS = 48 * 60 * 60 * 1000;
export const UPDATE_BASE_HEADER = "Scope-Update-Base";
export const QueuedPublication = Schema.Struct({
  id: ArtifactId,
  queued: Schema.Literal(true),
  expiresAt: Schema.String,
});
export type QueuedPublication = typeof QueuedPublication.Type;
export const PublicationResult = Schema.Union([Artifact, QueuedPublication]);
export type PublicationResult = typeof PublicationResult.Type;
export const HubQueue = Schema.Struct({
  limit: Schema.Literal(MAX_BUFFERED_TABS),
  items: Schema.Array(
    Schema.Struct({
      id: ArtifactId,
      expiresAt: Schema.String,
      title: Schema.optionalKey(Schema.String),
      status: Schema.Literals(["staging", "queued", "blocked"]),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type HubQueue = typeof HubQueue.Type;
export const ArtifactPage = Schema.Struct({
  items: Schema.Array(Artifact),
  next: Schema.NullOr(ArtifactId),
});
export const BlobReceipt = Schema.Struct({ blob: BlobId });
export const DeleteReceipt = Schema.Struct({ id: ArtifactId, deleted: Schema.Boolean });
export type DeleteReceipt = typeof DeleteReceipt.Type;
export const DiagramEvent = Schema.Struct({
  type: Schema.Literal("diagram"),
  id: ArtifactId,
  name: ArtifactName,
  event: Schema.Literals(["changed", "message", "proposal", "accepted", "rejected"]),
  version: Schema.String,
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
});
export type DiagramEvent = typeof DiagramEvent.Type;
export const PlanEvent = Schema.Struct({
  type: Schema.Literal("plan"),
  name: ArtifactName,
  id: ArtifactId,
  version: Revision,
  event: Schema.Literals(["comment", "round", "response", "review"]),
  roundId: Schema.optionalKey(PublicationTabId),
});
export type PlanEvent = typeof PlanEvent.Type;
export const PullRequestsEvent = Schema.Struct({
  type: Schema.Literal("pull-requests"),
  name: ArtifactName,
  id: ArtifactId,
  generation: Revision,
});
export type PullRequestsEvent = typeof PullRequestsEvent.Type;
export const PublicationsEvent = Schema.Struct({
  type: Schema.Literal("publications"),
  id: ArtifactId,
  tabId: PublicationTabId,
});
export type PublicationsEvent = typeof PublicationsEvent.Type;
export const LiveEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("artifact"), artifact: Artifact }),
  Schema.Struct({ type: Schema.Literal("deleted"), id: ArtifactId }),
  DiagramEvent,
  PlanEvent,
  PullRequestsEvent,
  PublicationsEvent,
]);
export type LiveEvent = typeof LiveEvent.Type;

export class ScopeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ScopeError";
    this.status = status;
  }
}

export function decode<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
}

export function validateArtifactContent(artifact: Pick<Artifact, "kind" | "mediaType">): void {
  const accepted: Record<string, readonly string[] | null> = {
    text: ["text/plain"],
    markdown: ["text/markdown"],
    html: ["text/html"],
    plan: ["text/html"],
    "pull-requests": ["text/html"],
    image: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"],
    file: null,
    excalidraw: ["application/vnd.excalidraw+json"],
  };
  if (
    Object.hasOwn(accepted, artifact.kind) &&
    accepted[artifact.kind] &&
    !accepted[artifact.kind]?.includes(artifact.mediaType)
  ) {
    throw new ScopeError(400, "The media type does not match the artifact kind.");
  }
}

export function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Use HTTPS, or HTTP on loopback, without URL credentials or query parameters.");
  }
  if (url.pathname !== "/") throw new Error("Use the Scope origin without a path.");
  return url.origin;
}
