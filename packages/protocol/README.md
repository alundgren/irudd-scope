# Artifact protocol

`src/index.ts` owns the validated wire types and limits. `src/client.ts` is the HTTP client used by CLI and desktop main. TypeScript types derive from Effect Schema definitions.

An artifact is the latest content and metadata for one stable ID. A revision is an increasing integer for that ID. A blob is immutable content addressed by its SHA-256 digest. An absent source field means unknown; it never blocks publication.

The desktop owns the API and persistent library. `LocalConnection` defines the version 1 discovery file with `endpoint` and `token`, validated as loopback HTTP. Its default path is `~/.config/irudd-scope/desktop.json`, overridable through `SCOPE_CONNECTION_FILE`. Desktop main writes it with mode `0600`; the CLI reads it when no endpoint or token override is supplied. Explicit endpoints require explicit credentials and never receive the discovered local token implicitly.

The optional hub forwards the same requests and responses without storing artifacts. An unavailable desktop causes a connection error directly or a 503 through the hub. No publication is queued or replayed. A failed response does not prove a write was rolled back; read the artifact before retrying an uncertain update.

The API uses a bearer token on every `/v1` request. It has no browser CORS access. Content responses are downloads; desktop rendering applies its own isolation. HTTP is allowed only on loopback. Remote clients use HTTPS, normally Tailscale Serve.

| Request                                       | Result                                            |
| --------------------------------------------- | ------------------------------------------------- |
| `POST /v1/blobs`, raw bytes                   | `{ blob }`, a SHA-256 ID                          |
| `PUT /v1/artifacts/:id`, `ArtifactWrite` JSON | Current `Artifact`; `expectedRevision: 0` creates |
| `GET /v1/artifacts?after=:id`                 | `{ items, next }`, ID-ordered pages of 100        |
| `GET /v1/artifacts/:id`                       | Current `Artifact`                                |
| `GET /v1/artifacts/:id/content?revision=N`    | Content, or 409 if the revision changed           |
| `GET /v1/events`                              | SSE `ready` and `artifact` events                 |

Update requires the revision last read. A 409 means reload and decide whether to apply the update again. The client wraps content upload and metadata publication into one operation. Failed publication can leave an unused blob row in the desktop's SQLite database. The API returns only the current revision and provides no deletion operation. Storage details and recovery belong to the [desktop](../../docs/storage.md).

Limits are 32 MiB per artifact, 16 KiB metadata, four simultaneous uploads, and eight event streams. SSE disconnects clients that cannot consume data; reconnect and list artifacts to recover. The stream does not promise event replay. It never replaces the persistent artifact list.

Known kinds include text, Markdown, HTML, image, file, and Excalidraw. The transport accepts bounded kind names; the desktop displays an unfamiliar kind as a downloadable file. Image preview accepts PNG, JPEG, WebP, GIF, and AVIF. Renderers must treat content as untrusted regardless of the declared kind.

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
uses the `scope-response-status` header. Only artifact paths and GET, POST,
or PUT are accepted; the Mac supplies its own local publishing token.

The hub permits sixteen active requests, bounded request bodies, and one
connected Mac. Event heartbeats keep the connection active. Disconnecting
cancels every transfer and returns 503 where headers have not been sent.
No request survives reconnection. The local management endpoints generate
pairing links, report status, and revoke access. Removing a paired remote
uses authenticated `DELETE /v1/relay/disconnect` to revoke its credential.
