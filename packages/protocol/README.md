# Artifact protocol

`src/index.ts` owns the validated wire types and limits. `src/client.ts` is the HTTP client used by CLI and desktop main. TypeScript types derive from Effect Schema definitions.

An artifact is the latest content and metadata for one stable ID. A revision is an increasing integer for that ID. A blob is immutable content addressed by its SHA-256 digest. An absent source field means unknown; it never blocks publication.

The desktop owns the API and persistent library. `LocalConnection` defines the version 1 discovery file with `endpoint` and `token`, validated as loopback HTTP. Its default path is `~/.config/irudd-scope/desktop.json`, overridable through `SCOPE_CONNECTION_FILE`. Desktop main writes it with mode `0600`; the CLI reads it when no endpoint or token override is supplied. Explicit endpoints require explicit credentials and never receive the discovered local token implicitly.

The optional hub forwards the same requests and responses without storing artifacts. An unavailable desktop causes a connection error directly or a 503 through the hub. No publication is queued or replayed. A failed response does not prove a write was rolled back; read the artifact before retrying an uncertain update.

The API uses a bearer token on every `/v1` request. It has no browser CORS access. Content responses are downloads; desktop rendering applies its own isolation. HTTP is allowed only on loopback. Remote clients use HTTPS, normally Tailscale Serve.

| Request                                              | Result                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/artifacts/:id/tab`, `{ expectedRevision }` | Persisted queued tab receipt `{ tabId }`                                      |
| `POST /v1/tabs/:tabId/blobs`, raw bytes              | Tab-owned content receipt `{ blob }`                                          |
| `PUT /v1/artifacts/:id`, `ArtifactWrite` JSON        | Current `Artifact`; requires `tabId`, uploaded `blob`, and `expectedRevision` |
| `GET /v1/artifacts?after=:id`                        | `{ items, next }`, ID-ordered pages of 100                                    |
| `GET /v1/artifacts/:id`                              | Current `Artifact`                                                            |
| `GET /v1/artifacts/:id/content?revision=N`           | Content, or 409 if the revision changed                                       |
| `DELETE /v1/artifacts/:id`                           | `{ id, deleted }`; already absent returns `deleted: false` with success       |
| `GET /v1/events`                                     | SSE `ready`, `artifact`, and `deleted` events                                 |
| `POST /v1/maintenance/shrink`, `{ timeoutMs }`       | `ShrinkReceipt` for both desktop databases                                    |
| `GET /v1/maintenance/status`                         | Latest available desktop maintenance receipts                                 |

Publication commits the tab first, then uploads content, then publishes metadata.
`expectedRevision: 0` creates an artifact; updates require the revision last read.
A closed tab cannot accept metadata or content, even if a caller retained its ID.
A 409 means reload and decide whether the update should still be applied. A new
explicit create can reuse a deleted artifact ID, with a revision greater than
those issued before deletion. Revisions are not necessarily consecutive across
creation and deletion. The client performs all three publication requests.

This protocol requires updated publishers and relays. The former ownerless
`POST /v1/blobs` route is no longer supported. CLI command syntax is unchanged.
Failed uploads and updates retain only tab-owned staging references, expiring
fifteen minutes after upload. Queued tabs without published metadata expire
when their staging references expire. Successful overflow publications retain
their queued tab. The desktop's [storage documentation](../../docs/storage.md)
defines imports, deletion, and cleanup timing.

A deletion event is `{ "type": "deleted", "id": "ARTIFACT_ID" }`. Clients remove
that artifact and its cached content. A reconnect replaces the local list with
the authoritative list, applying events received during the refresh. A delayed
list or content response must not restore an artifact deleted in the meantime.

`src/maintenance.ts` defines bounded request and receipt schemas. Manual shrink
bypasses size and interval gates, but obeys locking and disk-space checks.
Receipts contain a target and one entry per database, with before/after main-file,
WAL, and allocated bytes, duration, status, last-success time, and reasons or
staged bytes still deferred. Manual callers must treat deferred and failed
entries as unsuccessful work, even though the HTTP response contains a receipt.
No receipt contains tokens, raw stored documents, or database paths.

Maintenance supports a supplied deadline up to 600,000 ms, independently of
ordinary upload timeouts. A disconnected caller can read maintenance status;
there is no automatic replay. The service continues accepted maintenance up to
its deadline. `irudd-scope shrink --status` reads the desktop result.

Limits are 32 MiB per artifact, 16 KiB metadata, four simultaneous uploads, and eight event streams. SSE disconnects clients that cannot consume data; reconnect and list artifacts to recover. The stream does not promise event replay. It never replaces the persistent artifact list.

Known kinds include text, Markdown, HTML, image, file, and Excalidraw. The transport accepts bounded kind names; the desktop displays an unfamiliar kind as a downloadable file. Image preview accepts PNG, JPEG, WebP, GIF, and AVIF. The desktop treats published HTML as trusted agent output and allows scripts and external resources.

## Paired hubs

`src/remote.ts` defines the pairing URL, receipt, and validated relay events.
A local CLI uses the same artifact API and discovery format with its hub's
publishing credential. That credential cannot open the desktop relay, and a
desktop connection token cannot call the local publishing or management APIs.

The Mac posts a one-time pairing secret to `/v1/pair` and receives the hub ID,
name, and connection credential. It then opens `/v1/relay/events`, a newline
delimited JSON stream of `ready`, `request`, and `cancel` events. On each
request it retrieves the body at `/v1/relay/requests/:id/body` when needed and
streams the response to `/v1/relay/requests/:id/response`. The response status
uses the `scope-response-status` header. Only the listed artifact and desktop maintenance paths with GET, POST,
PUT, or DELETE are accepted; the Mac supplies its own local publishing token.

The hub permits sixteen active requests, bounded request bodies, and one
connected Mac. Event heartbeats keep the connection active. Disconnecting
cancels every transfer and returns 503 where headers have not been sent.
No request survives reconnection. The local management endpoints generate
pairing links, report status, and revoke access. Removing a paired remote
uses authenticated `DELETE /v1/relay/disconnect` to revoke its credential.

Local management `POST /v1/hub/shrink` accepts the same `{ timeoutMs }` request
and returns a hub receipt. `GET /v1/hub/maintenance` reads the latest hub result.
Both require the local publishing credential. They work without a connected
Mac and are excluded from the desktop relay allowlist. The stateless forwarding
mode reports that it has no hub database. `irudd-scope hub shrink --status`
reads the local hub result.

## Diagram commands

`src/diagram.ts` defines semantic objects, operation batches, and the additive
`POST /v1/diagrams` endpoint. The normal publishing bearer token is required.
The hub forwards these commands to the desktop, which uses its trusted renderer.
No model key is involved. Read, apply, and preview require a loaded diagram tab.

| Action    | Input                                          | Result                                              |
| --------- | ---------------------------------------------- | --------------------------------------------------- |
| `create`  | `id`, `title`, `operations`, optional `source` | `{ type: "created", artifact }`, published revision |
| `read`    | `id`                                           | `{ type: "snapshot", diagram }`                     |
| `apply`   | `id`, `snapshot`, `operations`                 | Updated snapshot; edits save automatically          |
| `preview` | `id`, optional `snapshot`                      | PNG `data` in base64, ID, revision, and snapshot    |

Snapshots include the published revision, dirty flag, editable scene, selected IDs,
read-only objects, and omitted-object count. The snapshot is a SHA-256 digest of
revision and native document content. Apply rejects a changed snapshot or an
unresolved incoming revision. All operations validate before any edit. Native IDs,
styles, and unsupported objects are retained. Use opaque existing IDs verbatim;
new IDs start with a letter and contain letters, digits, underscores, or hyphens.
Existing native-file publication and saved diagram documents remain compatible.

Requests are limited to 512 KiB and 100 operations. The desktop allows four active
commands and one per artifact, each with a 20-second deadline. Disconnects cancel
pending editor work. A timeout can follow a completed write; read before retrying.
Preview is generated only on request, at most 2048 pixels on its longest side and
8 MiB before base64 encoding. Clients bound the complete JSON response to 16 MiB.
`irudd-scope diagram guide` returns the operation schema and usage instructions.
