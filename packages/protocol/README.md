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

Update requires the revision last read. A 409 means reload and decide whether to apply the update again. The client wraps content upload and metadata publication into one operation. Failed publication can leave an unused content file. Automatic cleanup and history retention are future storage work.

Limits are 32 MiB per artifact, 16 KiB metadata, four simultaneous uploads, and eight event streams. SSE disconnects clients that cannot consume data; reconnect and list artifacts to recover. The stream does not promise event replay. It never replaces the persistent artifact list.

Known kinds include text, Markdown, HTML, image, file, and Excalidraw. The transport accepts bounded kind names so a later renderer can add a kind without replacing the API. Older clients display an unfamiliar kind as a downloadable file. Image preview accepts common raster formats. Renderers must treat content as untrusted regardless of the declared kind.
