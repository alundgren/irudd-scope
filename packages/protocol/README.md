# Artifact protocol

`src/index.ts` owns the validated wire types and limits. `src/client.ts` is the HTTP client used by CLI and desktop main. TypeScript types derive from Effect Schema definitions.

An artifact is the latest content and metadata for one stable ID. A revision is an increasing integer for that ID. A blob is immutable content addressed by its SHA-256 digest. An absent source field means unknown; it never blocks publication.

An optional `name` is a second unique, immutable key (lowercase letters, digits,
and dashes, at most 128 characters). Existing writers that omit it preserve it.
`GET /v1/names/:name` resolves the current artifact.

The desktop owns the API and persistent library. `LocalConnection` defines the version 1 discovery file with `endpoint` and `token`, validated as loopback HTTP. Its default path is `%LOCALAPPDATA%\irudd-scope\desktop.json` on Windows and `~/.config/irudd-scope/desktop.json` on macOS and Linux, overridable through `SCOPE_CONNECTION_FILE`. Desktop main writes it with mode `0600` on Unix; Windows uses the current user's profile directory with inherited Windows access permissions. The CLI reads it when no endpoint or token override is supplied. Explicit endpoints require explicit credentials and never receive the discovered local token implicitly.

The paired hub forwards live requests and persists opted-in publications before attempting delivery, regardless of desktop connection state. Direct connections and stateless forwarding hubs require an available desktop. A failed response does not prove a write was rolled back; read the artifact and inspect the hub queue before retrying an uncertain publication.

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
A trashed or deleted tab cannot accept metadata or content, even if a caller retained its ID.
Desktop close retains content in Trashcan for seven days; read and list routes
include it and names remain reserved. Restore in Scope before updating a
trashed tab. `DELETE /v1/artifacts/:id` still deletes permanently.
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
connected Mac. Event heartbeats keep the connection active. On system resume,
new desktops reconnect enabled remotes with `Scope-Relay-Wake: 1` on
`GET /v1/relay/events`. This authenticated, one-time wake signal clears delivery
backoff and attempts queued publications immediately. Ordinary reconnects and
new publications respect the cooldown. Older hubs ignore the header; older
desktops retain their existing reconnection behavior. No relay event or persisted
field changes. Disconnecting
cancels every transfer and returns 503 where headers have not been sent.
If a non-GET request times out before the Mac fetches its body, the hub closes
that relay connection. The timed-out request keeps its timeout error; other
pending requests receive the disconnect warning because other writes may
have completed. The hub does not replay live requests. Later opted-in
publications can queue while disconnected. A GET timeout or a timeout after
body retrieval does not close the relay, so those stalls can still require
reconnection. Caller cancellation does not close the relay either.
Live requests end on disconnect. Publications can instead opt into durable
buffering by sending `Scope-Buffer-Publication: 1` on the tab reservation.
`ScopeClient.publishOrQueue` uses this option; `publish` retains synchronous
Artifact-only behavior. The hub issues its own tab ID, accepts one bounded
content upload, and returns 202 with `QueuedPublication` from the final PUT.
That receipt is `{ id, queued: true, expiresAt }`, with no desktop revision.
Every opted-in reservation uses the hub queue, including while the Mac is
connected or unresponsive. Connection state only controls background delivery
attempts; it never decides whether to persist an opted-in publication.
Existing synchronous clients retain live forwarding. Existing clients and older hubs keep working
online because reservation JSON and relay events are unchanged. Older hubs
return 503 offline.

The hub caps pending tabs, including incomplete uploads, at 50. Entries
expire 48 hours after reservation without retry extensions. Complete entries
deliver automatically while connected and survive hub restart. Transient
delivery failures back off for 3 seconds, doubling to a 5-minute cap. A successful
delivery or Mac wake resets the cooldown. Retry timing exists only in hub memory;
a hub restart starts fresh without discarding queued content. Delivery reads
the current desktop artifact and checks its revision before writing. After
an uncertain metadata acknowledgement, matching desktop content and metadata
confirm delivery; newer conflicting content remains untouched. Conflicts
retain a blocked entry until discard or expiry. A complete entry cannot be
replaced by another publication under the same ID.

Local `GET /v1/hub/queue` returns `HubQueue` with the cap and entries containing
ID, expiry, optional title, status of staging, queued, or blocked, and any
delivery error. `DELETE /v1/hub/queue/:id` discards pending content and cancels
its active delivery. Cancellation cannot undo a desktop write that already
committed; use the normal artifact delete if necessary. Both endpoints require
the local publishing token and reject browser origins. Unpairing deletes all
queued content and saved artifact metadata.

`ScopeClient.updateBase(ID_OR_NAME)` reads an artifact with
`Scope-Update-Base: 1`, trying the ID before its name. A connected hub forwards
the read to the desktop. Offline, the hub can answer these opted-in metadata
reads from its last observation of a successful artifact GET, named GET, or
artifact PUT, including buffered delivery. It retains at most 1,000 artifact
records for 48 hours after observation. The returned revision is the last
observed revision, not a guarantee of current desktop state. Publishing against
it through `publishOrQueue` preserves normal revision checks on delivery.
Missing saved metadata returns 503 with instructions to read or publish through
the hub while connected. Successful deletes and artifact 404s remove saved
metadata; unpairing clears it all. Older hubs and direct desktops ignore the
header and retain their existing read behavior. No artifact wire fields change.
Ordinary list and read requests, speech, and maintenance continue to require a connected desktop.

The local management endpoints generate
pairing links, report status, and revoke access. Removing a paired remote
uses authenticated `DELETE /v1/relay/disconnect` to revoke its credential.

The paired Mac can read `GET /v1/relay/update` and request
`POST /v1/relay/update` with `{ commit, retry? }`. `commit` is a full lowercase
Git SHA from the running Mac app. The local publishing credential cannot call
these endpoints. Bodies are limited to 1 KiB, browser-origin requests are
rejected, and the hub accepts no command, repository URL, or installation path
from the request.

`HubUpdateStatus` reports support, phase, running commit, target commit, and a
bounded message with optional build output. A POST returns 202 with the current status; it does not mean
the build has completed. Repeated requests for a running update reuse it, and
failed attempts for the same commit require `retry: true`. A missing endpoint
on an older hub requires a manual installation update. The optional `commit`
on local `HubStatus` identifies the running build for restart verification.
Existing pairing, relay events, and publication contracts remain compatible.

Local management `POST /v1/hub/shrink` accepts the same `{ timeoutMs }` request
and returns a hub receipt. `GET /v1/hub/maintenance` reads the latest hub result.
Both require the local publishing credential. They work without a connected
Mac and are excluded from the desktop relay allowlist. The stateless forwarding
mode reports that it has no hub database. `irudd-scope hub shrink --status`
reads the local hub result.

## Folder tabs

`src/folder.ts` defines the folder routes and contracts: `FolderIdentity`,
`FolderOpenRequest`/`FolderOpenReceipt`, find and select requests and
receipts, `FolderEntry`, `FolderListing`, `FolderChange`, `FolderFeedEvent`,
`FolderDropEvent`, the watch stream line, search and write contracts, and
`FolderErrorBody`. It imports no file system code. `MachineId` is `local` or a
paired remote's ID. Paths inside a folder use `/` and have no `.` or `..` parts.

Agent commands use the normal publishing token, locally or through a hub:

| Request                                                     | Result                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /v1/folders/open`, `{ path, title? }`                 | `{ tabId, machine, path, created }`                                             |
| `POST /v1/folders/find`, `{ path }`                         | `{ open, tabId?, machine, path }`; a tab in Trashcan or the drawer is not open. |
| `POST /v1/folders/select`, `{ path, file, lines?, title? }` | `FolderOpenReceipt` plus `file` and `lines` when given                          |
| `GET /v1/folders/watch?path=`                               | NDJSON `FolderWatchEvent` lines: `dropped`, `closed`, `heartbeat`               |

`path` is absolute on the machine that runs the command. Scope resolves it to
the canonical real path on that machine; hubs resolve it before relaying. Any
`machine` field in the body is ignored: the machine is the connection that
delivered the command. Folder commands are never queued. Failures are JSON
`{ error, code }` with `code` one of `no-tab`, `not-found`, `outside-folder`,
`not-a-directory`, `unsupported`, `desktop-offline`, `exists`, or `failed`. A 404 without a code
comes from a Scope or hub without folder support; the CLI then prints
`Update Scope on HOST to share folders`. `unsupported` with 501 means the feature
is missing on that machine. `failed`, usually 500, is an error Scope did not
expect, such as `EACCES` or `EMFILE`, or a busy limit; retrying can help, updating
cannot. A path whose canonical form passes through `.git` in any letter case,
including through a link, fails with 404 `not-found` "Scope does not show .git."
for every command, and no tab opens.

`select` checks `file`, relative to `path`, on the machine that has it before
opening anything: a path that leaves the folder fails with 403
`outside-folder`, a missing file with 404 `not-found`, and a directory with
`not-a-directory`. It opens the tab like `open` when needed. `watch` answers
404 `no-tab` when the folder has no open tab. Otherwise it writes one
`{"type":"dropped","paths":[...]}` line per finished drop, listing the
folder-relative paths the person copied in, a heartbeat
line every 10 seconds and ends after `{"type":"closed"}` when the tab is closed
or trashed. A stream that ends without `closed` means Scope disconnected.
Each hub relays at most `MAX_FOLDER_WATCHES` (16) watches, counted apart from
its 16 publication slots.

The hub serves the paired desktop's file requests on routes that accept only
the desktop connection credential, never the publishing token:

| Request                                                          | Result                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /v1/relay/folders/list?root=&path=&showIgnored=0\|1`        | `FolderListing` of one directory, at most 50,000 entries                                           |
| `GET /v1/relay/folders/read?root=&path=&start=&end=`             | Raw bytes `start` to `end` (exclusive), `Scope-Folder-File-Size`, and `Scope-Folder-File-Modified` |
| `GET /v1/relay/folders/events?root=`                             | NDJSON `FolderFeedEvent` lines with a heartbeat every 10 seconds                                   |
| `POST /v1/relay/folders/search`, `FolderSearchRequest`           | NDJSON `FolderSearchEvent` lines ending with `done`                                                |
| `PUT /v1/relay/folders/write?root=&path=&replace=0\|1`, raw body | `FolderWriteReceipt` once the file is committed in place                                           |

A `changes` line of the events feed may carry `ignoreRulesChanged`, the
directories whose `.gitignore` changed, with `""` for the folder's
`.git/info/exclude` or for `.git` itself appearing, moving, or being replaced. Entries at any depth below each one may have become ignored or
shown, so a reader reloads every listing it keeps at or below it. Such a line can
have an empty `changes` list. The feed reports nothing else inside `.git`.

Reads fail at once with 400 `not-a-directory` for FIFOs and other special files.
Ignore files are read only when neither they nor a folder above them inside
`root` is a link. A listed link that resolves into `.git` has `link: "outside"`
and no size.

Search matches `query` as plain text in any letter case and honours
`showIgnored`. A content search reads only regular files inside `root`, skips
binary files and files over 1 MiB, and
sends `match` lines with the path, line number, and line text, stopping at 1,000
with `done` and `truncated: true`. With `names: true` it matches file paths
instead and sends `file` lines, stopping at 10,000. Long searches send a
heartbeat at least every 10 seconds. Closing the request stops the search.

A write stages the body inside the folder and renames it into place after
checking containment again, creating missing folders on the way. It never
writes through a link. Without `replace=1` an existing entry, including one
created during the upload, fails with 409 `exists` and nothing is written; on a
file system without hard links it fails with 501 `unsupported` instead. With
`directory=1` the route creates an empty folder; without `replace=1` an existing
entry fails with `exists`. Closing the request before the answer is sent, even
after the whole body arrived, cancels the write and removes the staged file.

Every file route resolves real paths and rejects paths that leave `root`,
including through symlinks, with 403 `outside-folder`. A desktop sends
`Scope-Relay-Capabilities: folders` on `GET /v1/relay/events`; hubs forward
folder commands only to such a desktop and otherwise answer 501 `unsupported`
without sending a relay event, because older desktops drop the relay on an
unknown request.

### Durable folder operations

`src/folder-operation.ts` defines opt-in `folder-operations-v1`. Existing
`write` requests retain their original contract. A desktop must first read
`GET /v1/relay/folders/capabilities` and require that capability. An older hub
requires an update; the desktop must not fall back to an unversioned write.
All these routes require the paired desktop credential.

- `GET /v1/relay/folders/version?root=&path=` returns `{ version }`, an opaque
  regular-file version or `missing`. Versions fingerprint device, inode,
  size, mode, modification time and change time. No file content is retained.
- `PUT /v1/relay/folders/operations?root=&caller=` accepts raw streamed bytes
  and a `Scope-Folder-Operation` header containing base64url UTF-8 JSON of
  `FolderOperationRequest`. The existing 16 KiB request-header limit applies.
- `GET /v1/relay/folders/operation-status?caller=&requestId=` returns
  `FolderOperationStatus`, including the original receipt after completion.

A request contains `version: 1`, `requestId`, `path`, `kind`, `expectedVersion`,
`replace`, and `payload: { size, sha256 }`. IDs are creation time in epoch
milliseconds, a colon, and a lowercase UUID v4. `file` creates with
`expectedVersion: "missing"` and `replace: false`, or replaces with an observed
version and explicit `replace: true`. `directory` requires exclusive creation,
`missing`, no replacement, and the size and SHA-256 of an empty payload.
Missing parent directories are created by the existing contained writer.

The owner supplies `caller` from authenticated identity and resolves `root`
from the current source tab. Neither value should come directly from an
untrusted guest command. The hub binds the caller namespace to its authenticated
desktop principal. Local owners use `DesktopStore.folderOperations` through
`FolderSource.operations`. Peer transport and permission checks are separate.

The filesystem host serializes versioned operations and legacy writes in the
same process queue, including overlapping roots. File payload size and SHA-256
are checked while streaming; the expected version is checked immediately before
commit. Writes by external programs or another independently configured Scope
process are not locked. A change between the final check and rename can still
race. Native filesystem and containment limitations remain unchanged.

Intent is persisted in host SQLite before filesystem changes. Completion is
persisted before returning `completed`. The status can instead be `pending`,
`failed`, `unresolved`, `unknown`, or `expired`. Filesystem commit and SQLite
commit are separate: after a crash, an interrupted intent becomes `unresolved`
without replay, even if matching bytes are present. A retained completion stays
completed if an external program subsequently changes the file. Duplicate
requests return the retained outcome; changed command or declared payload
identity under the same ID fails with `request-mismatch`. Bytes on the first
execution must match that declared identity.

Retained outcomes expire 48 hours after the timestamp in the ID. The host keeps
at most 4096 unexpired records and rejects admission when full. A persistent time
floor prevents pruned IDs becoming fresh after clock rollback. Expired IDs never
execute. `unknown`, `unresolved`, and `expired` do not authorize retry with a new
ID: inspect and refresh the destination and obtain a new explicit action.
`failed` carries a typed error; `conflict` means the expected version changed.
Status lookup never writes files. Uploads have a 60-second idle timeout and a
12-hour total deadline, including queue time; bytes use streaming backpressure
and are independent of the artifact size limit. Queued cancellation closes the
body without committing it.

## Removed diagram routes

Scope no longer accepts `POST /v1/diagrams`, `POST /v1/diagrams/sync`, or
`POST /v1/diagram-agents`; the desktop returns 404 and paired hubs do not forward
them. The desktop no longer sends `diagram` SSE events. `ScopeClient.watch` skips
event types it does not know, so a newer CLI keeps watching an older desktop
that still sends them.

## Agent speech generation

`src/voice.ts` defines speech contracts and bounds. These additive routes use the
publishing bearer token and reject browser origins. Local access and paired hubs
use the same API. Scope must run on an awake Mac. The hub only forwards requests.

| Method and path                     | Action                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /v1/voice`                    | Submit `{ requestId, text, instructions?, voice?: "Aoede", "Leda", or "Kore" }`; returns 202 and a receipt. |
| `GET /v1/voice/:requestId`          | Read the existing receipt.                                                                                  |
| `GET /v1/voice/:requestId/result`   | Download completed WAV with `audio/wav`; otherwise 409.                                                     |
| `DELETE /v1/voice/:requestId`       | Cancel active local generation and return its receipt.                                                      |
| `POST /v1/voice/:requestId/billing` | Start a generation lookup and return 202 immediately; read status later.                                    |

New requests default to Aoede and the restrained conversational solo instructions
in `VoiceGuide.styles.solo`. Omitted or blank instructions use that style.
Explicit `instructions` replace it. `VoiceGuide.styles.conversation` provides
Aoede's lead instructions, Leda's reply instructions, and a 180 ms joining gap.
Each turn is a separate request; the agent joins exported WAVs. There is no
native multi-speaker generation or overlap. Mood follows the script's evidence.

Existing Kore receipts remain readable. During their lifetime, matching old
requests still recover their original results, including omitted settings;
they never regenerate under the new defaults. New requests use the new defaults.
Desktop, CLI, and hub must be updated together to accept the added voices.

`ScopeClient` exposes `submitVoice`, `voiceStatus`, `voiceResult`, `cancelVoice`,
and `refreshVoiceBilling`. Billing refresh performs no speech submission. It is
coalesced while running and limited to one lookup per request per five seconds.
Generation lookup uses OpenRouter `data.total_cost`, `model`, and `provider_name`.
A missing cost stays null with `billingStatus: "pending"`; missing generation ID
means `unavailable`. Actual model and provider stay null until metadata arrives;
`requestedModel` identifies the fixed requested model. A confirmed zero is valid
only when the provider reports zero. Downloads do not wait for billing.

Receipts include request ID, state, submission/expiry timestamps, generation ID,
requested and actual model, actual provider, voice, audio format/media type,
sample rate/channels/sample width, measured duration, elapsed generation time,
cost USD, billing status, and a bounded failure message when relevant. Audio is
24 kHz mono signed 16-bit little-endian PCM wrapped in WAV. Unexpected provider
formats fail rather than being mislabeled. Scope sends only supplied narration
and speech settings to OpenRouter, never artifacts, workspace data, provenance,
or credentials in the request body. Delivery instructions use documented
`speech_metadata.style` provider options, separate from verbatim narration.

Narration is limited to 16 KiB UTF-8, delivery instructions to 2048 characters,
and the complete JSON body to 128 KiB. Two generations may run at once; additional
requests return 429 without queuing. Scope retains requests for 24 hours from
submission, including failed and canceled IDs, with no request count limit.
Audio transfers are limited to 16 MiB.

A request ID is committed in SQLite before a paid call. Repeating the same ID
and normalized payload returns the existing receipt, including when voice is
disabled. Different payloads return 409. After expiry the ID is no longer
protected and can produce another paid request. Record the ID before submission.
HTTP timeout, a lost reply, CLI exit, or hub disconnection leaves accepted
generation running. Inspect that ID before taking further action; never choose
a new ID automatically after an uncertain outcome. Generation has a five-minute
deadline. Cancellation aborts local work but does not promise provider cancellation
or refund. Turning voice off blocks new generations and does not cancel accepted
work or delete the shared key.

Completed audio and receipts survive desktop restart. Unfinished requests become
`interrupted`, never queued, resumed, or regenerated. A crash after acceptance may
lose audio or generation metadata even when a charge occurred. Known generation
IDs still permit billing lookup for failed, canceled, and interrupted requests.
The local/hub request deadline remains short; each operation returns separately.

Agents can inspect `irudd-scope voice guide` or use:

```sh
irudd-scope voice generate narration.txt --request-id narration-unique-id \
  --instructions "warm and friendly" --output narration.wav --receipt narration.json
irudd-scope voice status narration-unique-id
irudd-scope voice result narration-unique-id --output recovered.wav --receipt narration.json
irudd-scope voice status narration-unique-id --refresh-billing --receipt narration.json
irudd-scope voice cancel narration-unique-id
```

The generation CLI polls short status requests, with a 330000 ms default command
timeout. Other voice commands share that default and accept `--timeout-ms`.
Audio export requires a new `.wav` file. Receipt exports may be refreshed in place.
Agents own their exported files, scripts, HTML, synchronization, and playback.

## Named pull request inboxes

Publish a named `pull-requests` artifact with `text/html` content. Its name and
kind are immutable. Its desktop tab is always permanent and cannot move to
Trashcan; deleting the artifact removes the inbox. HTML updates retain the
repository binding and current review data. `POST /v1/pull-requests` accepts
the commands defined in `src/pull-requests.ts`; `ScopeClient.pullRequests`
validates requests and replies. Normal publishing credentials and connected
desktop requirements apply. Paired hubs forward the route without storing PRs.

`read` looks up a named tab and returns a complete snapshot with `tabId`,
`generation`, repository, viewer, sync status, a flat `prs` array, and
`appState: { version, value }`. All other
commands require that `tabId`, the immutable name, and a UUID `requestId`.
Repository configuration can be repeated with the same repository, but changing
it requires another tab. The first complete inventory can normalize an alias to
GitHub's verified canonical owner/name, provided there are no cached PR rows
or a previously committed inventory. A successful empty inventory also pins that
binding. Later renames or transfers require a new inbox. `sync` uses the desktop user's installed `gh` and
returns the current snapshot. Configured live inboxes refresh automatically;
simultaneous refreshes of the same repository share remote reads while local
records remain tab-owned. The 500-point hourly account target delays new automatic
jobs; admitted jobs finish. Manual Sync and detail reads bypass that routine wait.
Every request still respects actual GitHub quota reserve and throttling.
Sync request IDs identify calls; they do not retain an inventory history.

Sync status retains `state`, `updatedAt`, `lastSuccessAt`, and `error`. Optional
`intervalMs`, `nextAttemptAt`, and `reason` report the adaptive refresh target and
retry policy in desktop IPC and the HTML SDK. HTTP replies retain the four legacy
sync fields so older CLI and hub clients continue decoding them. Older saved
snapshots remain readable by the updated desktop without the optional fields.

PR facts include title, author, labels, draft status, requested reviewers, size,
commit IDs, merge status, aggregate checks, and
`hasUnresolvedConversations`. That flag is true when any GitHub review thread is
unresolved, false after a complete read finds none, and null when unavailable.
Checks and merge status identify their observed commits. Unknown values are
distinct from success or absence. A complete sync removes records no longer
open. Failed or incomplete membership reads preserve the cached list and local values.

First load may publish a complete base inventory while `sync.state` remains
`syncing` and checks, mergeability, and conversations are Unknown. `lastSuccessAt` advances only after
enrichment finishes. Failed enrichment keeps the valid base rows; incomplete
membership reads keep the previous list. Once the base inventory is committed,
retries and later refreshes commit enriched facts atomically, including after restart. Optional scheduler status is supplied to authored apps by the desktop.

`review` adds `{ decision, hasApproval, headOid, observedAt }`. `decision` is
GitHub's overall `approved`, `changes-requested`, or `review-required` decision,
or null when GitHub supplies none. `hasApproval` is true when any reviewer's
current opinion is an active approval, even if another reviewer requests
changes. Dismissed and superseded approvals do not count. Null means that the
observed head changed during retrieval. This flag does not assert that required
reviews, CI, or other merge rules are satisfied.

`stack` is null for a known standalone PR or a native GitHub stack record with
`nodeId`, `number`, `position`, `size`, `baseRefName`, `members`,
`readyForReview`, `approved`, and `observedAt`. Members are ordered by native
position, starting at 1 nearest the target branch, and include PR `nodeId`,
`number`, `position`, `state` (`open`, `closed`, or `merged`), and `draft`.
`readyForReview` means every open member is out of draft. `approved` means every
open member has an active approval; it is null if approval is unknown and no
member is known to lack one. Closed and merged members do not affect either
flag. Membership uses GitHub's native stack records, without branch inference.
Complete membership and review pagination are required before saving a refresh.

The lightweight initial load omits review and stack fields until enrichment completes.
A focused PR refresh re-observes every open member of its native stack. Other
rows can retain older observations; use `stack.observedAt` for that stack record.

These two fields are optional so existing stored PR facts remain readable
without a database migration. Missing fields mean not yet observed, rather
than no approval or no stack. Existing authored HTML continues to receive the
same flat array with added fields. Update desktop, CLI, and hub together:
older strict protocol decoders reject newly enriched replies and saved rows.

`note`, `snooze`, `review`, and `assessment` mutations use independent current
versions. `expectedVersion` selects `local.noteVersion`, `local.snoozeVersion`,
`local.reviewVersion`, or `agent.version`, respectively. Inspection and review
have separate commit baselines and share the review version. Opening a PR
records inspection only; an explicit local review mark records the supplied
commit, including a commit inspected before newer changes arrived.
Assessments identify their author, covered commit, and evidence. Custom fields
have typed values and unique keys. Agent mutations replace current agent values,
without replacing GitHub facts or local state.

Identical local mutation payloads under the same request ID recover without
applying twice. Different payloads under that ID return 409. Receipts last for
the owning PR or tab lifetime. A conflict requires reading current state and
reconsidering the edit. A tab UUID check also prevents an old command modifying
a newly created tab that reuses the old name.

`detail` selects a PR node ID and returns its commit-bound body, review bodies,
files, and diff separately from the array. Changes during retrieval require
retrying against the current commit. No detail history is stored. Command JSON
is limited to 256 KiB and replies to 32 MiB. Inventories have no PR count cap;
an oversized complete snapshot fails rather than silently trimming the list.
Detail replies also limit diff text to 2,097,152 characters and files and
reviews to 10,000 records each. Oversized details fail the read; Open on GitHub
remains available from the cached PR row.

`details` loads a selective batch using `nodeIds`, a nonempty list of at most
20 distinct PR node IDs, with the same `name`, `tabId`, and `requestId` as
`detail`. It returns `{type: "details", tabId, results}`. Each result contains
`{nodeId, captured: {headOid, baseOid}, detail}` or `{nodeId, error}` in request
order. There is no load-all selector. A batch runs at most three reads at once,
shares concurrent and completed reads with individual requests, and does not
subscribe to live updates. The desktop bounds its completed cache by entry
count and serialized bytes, and removes obsolete comparisons.

Batches stop after 20 seconds and stay within the existing 32 MiB serialized
UTF-8 reply limit. A failed, changed, timed-out, or over-capacity PR returns an
error while successful results remain available. Retry failed IDs separately
or in a smaller batch. GitHub account changes, suspension, and tab removal
cancel pending reads. The existing single-PR commands and transport timeout
defaults remain compatible.

Each inbox owns one JSON object in `appState`, initially `{ version: 0, value: {} }`.
It belongs to the inbox rather than individual PRs and survives HTML updates,
complete syncs, removal of PRs, restart, and Trashcan retention. Permanent tab
deletion removes it and its mutation receipts. Scope's desktop UI does not
interpret or display this object.

The following commands require `name`, `tabId`, `requestId`, and
`expectedVersion` from `appState.version`:

| Action         | Additional fields | Behavior                                                   |
| -------------- | ----------------- | ---------------------------------------------------------- |
| `state-set`    | `value: object`   | Replace the complete object. Use `{}` to clear it.         |
| `state-patch`  | `value: object`   | Replace supplied top-level keys and retain other keys.     |
| `state-delete` | `keys: string[]`  | Remove the named top-level keys. Missing keys are allowed. |

Nested objects and arrays replace entire values during a patch. `null` is a
stored value; deletion is explicit. Every accepted new write increments the
state version and inbox generation, including empty edits. Identical retries
with the same UUID do not repeat the mutation or its event. Stale versions
return 409. Read current state, reconcile the intended change, and use a new
request ID rather than silently overwriting another writer.

State must be a JSON object with finite numbers, at most 32 KiB of serialized
UTF-8 JSON and 32 nested levels. Patch input and the resulting object both
respect these limits. Deletion accepts at most 1,000 keys per command.

Authored HTML uses `scope.pullRequests.state.read()`, which resolves to
`{version,value}`, and `set(value,expectedVersion)`,
`patch(value,expectedVersion)`, or `delete(keys,expectedVersion)`, which resolve
to the saved `{version,value}`. `watch(callback)` returns unsubscribe and
supplies frozen `{operation,version,value}` updates. `operation` is `snapshot`
for current state on subscription, load, or reconnect, and `set`, `patch`, or
`delete` for live mutations. Main and child HTML frames in the same inbox
receive updates without replacing their documents. Use `beforeClose` for
unsent edits; already issued state writes participate in the normal flush.

```js
const state = scope.pullRequests.state;
const stop = state.watch(({ value, version, operation }) => {
  renderHiddenFiles(value.hiddenFiles ?? []);
});
const current = await state.read();
await state.patch({ hiddenFiles: ["src/example.ts"] }, current.version);
```

Each open PR also has its own JSON object, initially `{version:0,value:{}}`,
accessed through `scope.pullRequests.state.forPR(nodeId)`. It exposes the same
`read`, `set`, `patch`, `delete`, and `watch` methods as inbox state. PR state
has no storage byte quota; finite-number JSON and the 32-level nesting limit
still apply. Root inbox state retains its 32 KiB limit.

Agents use `pr-state-read` with `name`, `tabId`, and `nodeId`. The commands
`pr-state-set`, `pr-state-patch`, and `pr-state-delete` also require
`requestId` and `expectedVersion` from that PR's state, with `value` or `keys`
as above. They return `{type:"pr-state",tabId,nodeId,state:{version,value}}`.
State bytes are loaded separately and never added to inventory snapshots.
The existing 256 KiB command and 32 MiB reply limits still apply to individual
transfers; use separate patches for larger accumulated objects. An object
larger than the reply limit cannot be read in full; use known keys to delete
or replace its content before reading it.

PR state survives HTML replacement, commit changes, restart, and Trashcan
retention. A complete sync removing a PR deletes its state and receipts;
reappearance of that node starts at version 0. Permanent tab deletion removes
all its PR state. State is isolated by both inbox tab UUID and PR node ID.
Each accepted write advances only that PR's state version and the inbox
generation. Identical retries do not repeat writes or notifications.

Per-PR live events carry only
`prStateChange:{nodeId,operation,version}`. HTML watchers load the current value
through a separate read and recover after reconnect. If several writes happen
before retrieval completes, the watcher can receive one `snapshot` containing
the latest version. Unsubscribe when a component closes. Writes and
`beforeClose` callbacks participate in the normal frame flush.

```js
const state = scope.pullRequests.state.forPR(pr.nodeId);
const current = await state.read();
await state.patch({ reviewedFiles: { "src/example.ts": file.sha } }, current.version);
const stop = state.watch(({ value }) => renderReviewedFiles(value.reviewedFiles ?? {}));
```

Live events contain the artifact ID, name, generation, and owning `tabId`.
Older notices may omit `tabId`; state payloads require a matching tab UUID
before the host delivers them to HTML frames. State mutations add
`stateChange: {operation,version,value}` with the committed state so HTML can
react without waiting for another snapshot read. Other events remain transient
invalidations. No edit history is replayed. Read a complete snapshot after
reconnect or remount. Older snapshots may omit `appState`; treat it as empty
version 0. Upgrade desktop, CLI, and hub together because older strict clients
cannot decode the additional snapshot and event fields.

Diff detail files expose optional `sha`, the file blob SHA reported by GitHub's
PR files API, or `null` when unavailable. Existing replies may omit it. This
identifies Git content, not the PR head commit or a hash of the diff text.
The loader preserves it from the existing paginated request without additional
GitHub calls. A captured comparison still identifies the head and base commits.

The CLI provides `pull-requests guide`, `read`, `configure`, `sync`, `detail`, and
`apply`. `apply` submits a validated JSON command file unchanged. Exported
snapshots and command files remain explicit local files.

### Authored HTML SDK

The host installs `window.scope.pullRequests` before authored scripts execute.
`watch(callback)` receives `(prs, context, sync)` initially and whenever the
durable snapshot or theme changes. It returns an unsubscribe function. Arrays
and their nested records are frozen. Context includes the tab name, repository,
GitHub viewer, and theme. Keep transient UI state in memory, save durable
preferences through `state`, and derive named views with ordinary JavaScript
predicates.

```js
const inbox = window.scope.pullRequests;
inbox.watch((prs, context, sync) => {
  const forMe = prs.filter((pr) => pr.requestedReviewers.includes(context.viewer));
  render(forMe, sync);
});
```

`sync()` requests refresh. `detail(nodeId, section, {headOid,baseOid})` returns the complete
commit-bound detail object; `section` is an app hint and does not limit that
reply. `watchDetail(nodeId, displayedHeadOid, displayedBaseOid, callback)` reports
the inspected PR and receives refreshed `{ body, reviews, fetchedAt, error }`
alongside its tab, PR, and captured commit IDs. It returns an unsubscribe function.
Subscribe when opening or switching a PR and unsubscribe on closing the pane.
All current detail subscriptions across the inbox and its content windows identify inspected PRs. Removing one subscription preserves the others.
Failed updates retain the prior content and carry an error; they do not replace
the captured diff. Existing apps using only `detail` remain supported.
Each review retains its own `headOid`; the subscription commit IDs identify the
pane's displayed comparison. Description and reviews continue refreshing when
the current head or base changes, while the captured diff stays fixed.

Local mutation methods require the version the user acted on:

| Method                                                           | Version argument         |
| ---------------------------------------------------------------- | ------------------------ |
| `saveNote(nodeId, text, expectedVersion)`                        | `pr.local.noteVersion`   |
| `setSnooze(nodeId, { until, wakeOnNewCommit }, expectedVersion)` | `pr.local.snoozeVersion` |
| `inspect(nodeId, displayedHeadOid, expectedVersion)`             | `pr.local.reviewVersion` |
| `markReviewed(nodeId, displayedHeadOid, expectedVersion)`        | `pr.local.reviewVersion` |

These methods resolve to `{ version }` after a successful write and reject on
conflict. Use `until: null` to clear a snooze. The host supplies the tab UUID
and current snooze commit. Capture a note's version when editing begins, retain
the dirty text after failure, and let the user reconcile a newer saved note.
An Undo should use the preceding operation's returned version, so it cannot
erase a later edit from another client. Keep review navigation IDs and the
displayed commit stable when incoming arrays change; offer an explicit action
to load newer code.

`beforeClose(asyncCallback)` registers pending edit flushes and returns a
cleanup function. The host awaits them and already issued local mutations
before closing or replacing the HTML revision. A rejected flush keeps the app
open with its in-memory edits. Scope does not persist arbitrary renderer drafts.

`scope.pullRequests.loadDetails(nodeIds)` exposes the selective `details` batch
and resolves to its ordered per-ID results. Loading warms the temporary cache
without recording inspection or starting live subscriptions.

`scope.windows.open({ title, html, context })` opens caller-authored HTML in a
movable, resizable floating window and resolves to its ID. The same SDK is
injected before its scripts run. Each frame exposes immutable
`scope.window = { id, openerId, context }`; the main frame has ID `main` and null
opener/context. All frames share live snapshots, theme and matching detail
updates. Window content and its diff presentation belong to the HTML app.

`scope.windows.close(id)` flushes that child before closing it; omit `id` to
close the current child. Failure keeps it open. Escape closes the focused
window unless its HTML consumes the key. Closing returns focus to a surviving
opener or the main inbox. HTML replacement and quit flush all affected frames.
Window contents, position, size and arbitrary UI drafts are temporary.

`scope.windows.broadcast(value)` sends transient `{ senderId, value }` messages
to every mounted frame in this inbox, including the sender.
`scope.windows.watch(callback)` returns unsubscribe; it has no replay.
Context and broadcast values must be JSON, at most 64 KiB and 32 nested levels.
HTML is limited to 32 MiB. Each inbox supports eight simultaneous windows.

## Native structured plans

Publish `kind: "plan"`, `mediaType: "application/json"`, an immutable name and
version 1 JSON through the ordinary artifact publication API. New plans start
permanent. Replacements require the explicit artifact revision. The shared
[plan contract](src/plan.ts) validates UTF-8 bytes, bounded records, unique IDs,
references, visual anchors, goal consistency and acyclic item dependencies.
Desktop publication validates bytes and preservation inside its transaction.
Invalid or stale replacement leaves the stored content and revision unchanged.

The proposal has title, overviewHtml, optional context, constraints, questions,
goals, visuals, checks and items. A basis contains ID, source artifact revision
and the exact proposal, excluding nested bases and records. New bases must match
the current stored proposal and revision. Agreements identify a basis and its
targets; evidence identifies a basis and its check, expected/observed behavior,
implementation, conditions, result and references. Existing bases cannot change
or disappear. Existing records cannot change. Deliberate record removal requires
its ID in `removedRecordIds`; prior removal IDs remain and cannot be reused.
No check or visual update automatically carries old evidence forward.

The CLI field guide is `plan guide`. Commands are `plan publish NAME PLAN.json
OVERVIEW.html [--expected-revision N]`, `plan read NAME`, `plan item NAME ITEM_ID`,
`plan content NAME --output NEW_FILE.html`, and `plan capture-basis NAME BASIS_ID
--expected-revision N`. Omitted revision on publish means create only. Capture
adds the exact current basis through guarded publication and records no agreement.
Read again before adding records and use the new artifact revision. Generic
`update` rejects structured plans. `read` returns artifact and document; selected
packets separate owned checks, prerequisites and related context and retain exact
recorded proposals. Content export preserves the authored HTML bytes as UTF-8.

Overview receives `window.scopePlan.data` before authored scripts. Declarative
`data-plan-goal`, `data-plan-check`, `data-plan-procedure` and `data-plan-checks`
bindings provide goal text, expectations, complete procedures and ordered visual
check lists. A recorded view injects that basis's data. No sandbox or content policy
is added to trusted authored HTML.

The total byte limit is 32 MiB, including bases. Collections are limited to 2,000
records, text fields to 262,144 characters, labels to 512, titles to 160 and IDs
to 128. Early drafts may omit empty collections. Reads and basis capture need the
desktop online. Same-version hubs forward reads and queue JSON publications through
existing routes. A queued receipt confirms storage at the hub, not delivery.
Installed older hubs reject JSON until updated separately. Legacy `text/html`
plan publications become ordinary HTML and cannot downgrade a structured plan.

## Named retrospectives

Publish a permanent named `retro` artifact with `text/html` content using
`irudd-scope add report.html --retro --name RETRO_NAME`. `POST /v1/retros`
accepts validated `RetroCommand` values from `src/retro.ts`;
`ScopeClient.retro` validates bounded replies. `irudd-scope retro guide`
provides the exact current schemas. Upgrade desktop, CLI and paired hubs
together for this additive kind and route.

The public configuration lists the machine running Scope and its paired remotes,
runtime roots, repository inclusion and optional memory destinations. Source
`location` identifies the desktop hostname or the remote pairing ID and endpoint.
A null `sshAlias` on a remote does not mean the agent's local machine. Agents
resolve access using their existing tools; an HTTPS endpoint is not an SSH alias.
The optional location field keeps stored configurations readable. Existing local
source IDs and matching paired-remote IDs retain their preferences and tracking.
Unpaired manual sources are omitted from current settings; their audit tracking
remains stored. Configure commands can change preferences, but cannot add or
remove machines. Stale machine lists return a conflict and require fresh settings.
Desktop settings and credentials remain owned by desktop main. Retro commands inspect
configuration, tracking and completed history, publish normalized reports and
inventory pages, record review decisions and requests, and save authored JSON
state. Reports distinguish exact, estimated and unavailable metrics. Scope
stores no full native transcript archive.

First-use source coverage accepts `all`, `from-now` or `from-date` initialization.
Only `from-date` requires `initializationCutoff`, a valid UTC timestamp no later
than `discoveredAt` or the current time. `discoveredAt` stays the actual metadata
discovery bound for session creation and activity. Successful finish saves the
chosen historical cutoff for `from-date` and the discovery cutoff for `from-now`.
Both modes select whole native sessions started strictly after their fixed cutoff;
unknown creation times cannot qualify. `all` has no start-date filter. Existing
reports and tracking rows for `all` and `from-now` remain readable. Upgrade the
desktop, CLI, paired hubs and bundled skills together before using `from-date`.

Writes identify the immutable name and tab, a UUID request ID and the expected
record version. Keep identical payloads and request IDs for uncertain retries.
On a conflict, read and reconcile before a new write. Paginated reads use the
returned cursor and version where required. HTML updates preserve saved review
records. Agent report updates cannot silently transfer human acceptance to a
different proposed edit.

Only an authenticated agent command can finish a retro after the operator's
instruction. Before the transaction, a mounted report flushes its pending writes
and authored drafts. Failed flushes leave tracking unchanged. A successful flush
can advance the version and require the agent to read and retry. The transaction freezes report state and HTML, commits explicit
initialization even for empty successful inventories, and marks reviewed
session IDs per source and runtime. Missing sources remain unchanged. An
interrupted retro commits no reviewed-session markers or initialization. Report
publication records the explicit retro-agent exclusion immediately, including
for interrupted retros. Deleting a finished report removes its
history entry and content while retaining independent tracking.

`window.scope.retros` provides authored HTML with snapshots, decisions,
comments, investigation requests, bounded app state, history and pending-edit
flush callbacks. It exposes no finish or execution capability. Acceptance does
not apply a file change. The existing agent applies agreed edits and commits
before finish. The [retro authoring guide](../../.agents/skills/irudd-scope/references/retros.md)
contains the operational workflow. Live retro commands require an awake,
connected desktop, including through a paired hub. Initial HTML publication
uses the ordinary publication queue.

## Harnesses

`src/harnesses.ts` defines the harness scan, its limits and the guide printed by
`irudd-scope harnesses guide`. `GET /v1/harnesses?machine=local` returns
`{ machines: [HarnessScan] }` with the latest scan; `machine` defaults to
`local`. `POST /v1/harnesses/scan` with `{ "machine": "local" }` starts a scan
and returns the same reply once every fact except folder sizes is known. Other
machine values answer 400. `GET /v1/harnesses/file?machine=local&harness=HARNESS&path=PATH`
returns `HarnessFileReply` `{ harness, path, bytes, lines, sha256, text }` for one
global instruction file or own skill's `SKILL.md` that the latest scan lists.
`harness` is a harness id or `shared` for `~/.agents/skills`, and `path` is
relative to that folder (`~/.codex`, `~/.claude`, `~/.cursor`, `~/.grok` or
`~/.agents/skills`), for example `CLAUDE.md` or `skills/review/SKILL.md`. Paths
with `..` or `~` and absolute paths answer 400; files the scan does not list,
links, files with more than one hard link, files over 256 KiB and text that is
not UTF-8 answer 403 without returning content; a listed file or folder that is
gone answers 404; no scan yet, or a file replaced while it was opened, answers 409.
All routes need the publishing token and a running desktop; hubs do not forward
them and nothing is queued.

A `HarnessScan` holds `machine`, `scannedAt`, one `HarnessReport` per supported
harness (`codex`, `claude-code`, `cursor`, `grok`) and `sharedSkills` for
`~/.agents/skills`. A report has `found`, `home`, `version`, `signIn`
(`state` and an optional non-secret `method`), `size`, `skills`, `agents`,
`mcpServers`, `instructions` and `unreadable`. Paths are written from `~` with
`/`. `size` is `{ state: "pending" }` while the desktop counts and
`{ state: "done", bytes, files, parts }` when it finishes; `null` when the
harness is not found. Skills and agents carry `location` (`own` or `bundled`)
and `linked`; MCP servers carry only `name`, `transport` and `location`.
Instruction files carry `path`, `linked`, `bytes`, `lines` and `sha256`; a
linked file has null `bytes`, `lines` and `sha256` because its target is never
read. `sharedSkills` carries `found`, `linked`, `skills` and `truncated`; a
linked shared folder lists nothing. A scan's JSON is at most 256 KiB: lists
keep at most 1,000 skills or agents and 500 MCP servers, the scanner shortens
the longest lists until the scan fits, and each shortened report has
`truncated: true`. The client validates replies but keeps fields a newer
desktop adds.

## Personal memory

`src/memory.ts` defines the memory configuration, per-machine status, and the
agent guide printed by `irudd-scope memory guide`. `GET /v1/memory` returns the
desktop view and `POST /v1/memory/connection` with `{ "repository": "OWNER/NAME" }`
connects a repository after the operator turned memory on (409 otherwise).
Paired hubs forward both routes. A hub also answers `GET /v1/hub/memory` with
the local publishing credential, so `irudd-scope memory status` works while the
Mac is offline or its relay stops responding. The hub fallback has its own
request deadline. Its response includes the local machine, `desktopUnavailable`,
and the desktop error; a startup error does not label the Mac offline.

The Mac sends `PUT /v1/relay/memory` with its configuration when a relay
session starts, after every change, and once a minute. Writes to each hub are
serialized and retry missed configuration updates. `GET /v1/relay/memory`
reads local status, and `POST /v1/relay/memory/sync` runs a sync immediately.
Configuration changes can interrupt that sync. The last configuration from the Mac wins. An older hub answers 404 and
the Mac reports that the remote needs an update.

## Librarian

`src/librarian.ts` defines the schema printed by `irudd-scope librarian guide`.
`librarian read` returns the desktop presentation. `librarian apply REQUEST.json`
sends a validated command to authenticated `POST /v1/librarian`.

The presentation includes the person's current view (`browse`, `memory`,
`connections`, `stages`, `activity`, `machines`, `decision`, `overview` or
`recovery`), the shared `focusPath` and each view's settings. `ScopeClient`
checks only the reply envelope and passes other fields through unchanged, so
later views and fields reach agents without a client update. CLIs released
before these views reject the newer replies until they are updated. An agent
`select` of `browse` clears the person's filters so the agent sees plain results.

Local setup selects an absolute bundle location and can initialize only an empty
folder. Start and explicit resume bind an existing agent session to a run and
return a temporary capability. Start without `automaticPermissions` allows the
routine categories in the guide's `routine` list. A list narrows them, and `[]`
sends every proposal to the person. Resume keeps the run's list unless it
supplies a new one. Category names are labels; irudd-okf decides which changes
need a human, and Scope queues those for a human decision, including when
irudd-okf refuses the agent review. Proposal, presentation, selection, undo and finish
commands require that connection plus a stable request ID and expected UI
revision. The endpoint has no human decision action. Scope's validated renderer
IPC records human decisions against the displayed revision and exact source
list. File acceptance, recall and restoration remain irudd-okf operations.

Reads are bounded: the selected memory, proposal or recorded change, ten
completed summaries, and fixed-size pages of summaries for results, facets,
connections, stages, activity and recent runs. Queues remain durable in SQLite. Restart interrupts
runs and invalidates capabilities. Retried request IDs require identical payloads;
a receipt never grants a restored connection. Finish requires a separate explicit
user instruction and no pending proposals. All conversation stays in the existing
coding session. Weekly reminders merely announce that dreaming is due.

## Prompt library and current workspace

`@irudd-scope/protocol/prompts` defines the code-owned `text-to-image-seven`
structure, its seven fixed fields, validated documents, commands and replies.
`irudd-scope prompts guide` prints the exact command JSON Schema and bounds.
The library starts empty. Agents curate examples; Scope keeps one current
workspace with independent copied text. There is no generation, library import,
saved-prompt collection or prompt history.

Use `ScopeClient.prompts(command)` or authenticated `POST /v1/prompts`.
Read actions are `structures`, `read-workspace`, `list-items`, and `read-item`.
`list-items` accepts optional `field`, `search`, and `cursor` and returns at most
25 complete items, a `libraryRevision`, and a nullable next cursor. Pages sort by
stable item UUID. Search applies the same Unicode case conversion to item text
and the query before selecting a page. Keep filters fixed while continuing. A
library change makes
old cursors return 409; restart the read without a cursor.

Mutation actions are `create-item`, `update-item`, `delete-item`, `set-image`,
`update-workspace`, and `reset-workspace`. Every mutation carries a stable UUID
`requestId` and `expectedRevision`. Creation uses revision zero and an explicit
item UUID that has never been used, including by a deleted item. Retained creation
receipts prevent deleted IDs from being recreated at revision one. Other item
operations use the item revision. Workspace operations use the workspace revision. An identical retry returns its original receipt without
another write or event. Reusing an ID with different content, or using a stale
revision, returns 409. Read again and reconsider the edit before submitting a
new request ID. Mutation receipts contain `requestId`, `action`,
`workspaceRevision`, `libraryRevision`, and optional `itemId`/`itemRevision`.

An item contains `type: "text-to-image"`, `structureId: "text-to-image-seven"`,
`structureVersion: 1`, `field`, `name`, `fragment`, optional `description`, and
optional `exampleScene: {title, prompt}`. Updates replace that metadata and keep
the image. The item's field and structure cannot change. An item returned by a
read also has `id`, `revision`, and optional `image` metadata. A selected workspace
part stores `{itemId: UUID | null, text: string}` for each of `subject`, `action`,
`environment`, `lighting`, `style`, `composition`, and `camera`. Selection must
match the field and structure, but its copied text may be edited. Library edits
preserve copied text. Deletion atomically detaches affected selections and
preserves their text. Reset clears the workspace and keeps the library.

`assemblePrompt` trims each field, collapses whitespace, removes trailing
periods, commas, semicolons and colons, capitalizes the first character and adds
a period. It skips blank fields and joins the seven fields in the order above.
It preserves punctuation inside the text and makes no provider requests.
Capitalization can expand a character, such as `ß` to `SS`; the rendered output
retains the complete result within the overall reply byte limit.

`set-image` accepts `image: {mediaType, base64}` or `image: null` to remove the
image. PNG, JPEG and WebP files retain their original bytes. Uploads require
matching file signatures and MIME types, valid dimensions and complete container
metadata. PNG checks include chunk checksums. These checks do not decode every
pixel. Limits are 8 MiB per image and 1 through 4096 pixels per dimension.
Image metadata includes its SHA-256 `id`, `mediaType`, `size`, `width`, and
`height`. `ScopeClient.promptImage(itemId, imageId)` uses authenticated
`GET /v1/prompts/items/UUID/images/SHA256`. The image must still be attached to
that item; replaced, removed or deleted references return 404.

`ScopeClient.exportPromptLibrary()` downloads authenticated
`GET /v1/prompts/export`. The ZIP contains `manifest.json`, `library.json`,
code-owned structure metadata and original referenced images. The manifest uses
`format: "scope-prompt-library"`, `version: 1`, library revision, item count,
`itemsFile`, and an image list with archive-relative `file` paths. Controlled
paths are `images/SHA256.png`, `.jpg`, or `.webp`. Export reads one consistent
SQLite snapshot. It excludes the active workspace, credentials and unrelated
artifacts. Example scenes are separately authored library metadata.

Text is bounded to 8192 characters, names to 160, descriptions to 2048, and the
library to 2000 items. Commands allow 12 MiB, replies 2 MiB, and ZIP exports
128 MiB. Exports that exceed the limit fail without changing the library.

The existing live stream includes
`{type: "prompts", workspaceRevision, libraryRevision, workspaceChanged,
libraryChanged}` after committed changes. Reads, rejected writes and identical
retries emit nothing. Subscribe before reading the initial snapshot. Events
invalidate cached reads and have no durable replay; reconnect requires fresh
workspace and visible-library reads. A desktop editor must retain dirty local
text and handle revision conflicts explicitly. Agent commands never navigate
the selected desktop tab. Paired hubs forward these routes only while the
desktop is connected; prompt commands and exports are never queued offline.

Guest connections use the versioned schemas in `src/guest.ts`: one-use invitations,
fresh server challenges, paired device proofs, and session capability replies.
Endpoints contain a canonical Tailscale IPv4 address in 100.64.0.0/10 and a
port from 1 through 65535. They stay in protected desktop storage. Desktop
discovery validates the exact address against current Tailscale peer records
before opening a direct HTTP connection; redirects and DNS names are rejected. The peer listener exposes only registered owner operations; these
contracts do not grant publishing or arbitrary desktop IPC access.

## Guest pairing

Guest protocol version 2 owns device IDs, peer names, one-use invitations and pair
credentials. A `scope-guest://v2/` invitation contains the issuing device, its
validated tailnet endpoint, a five-minute expiry and a random bearer secret.
Desktop main copies and reads it. It is not a publishing or browser credential.

The receiver reviews and consents before claiming. The issuer verifies the
receiver endpoint and obtains its own named consent. HMAC-authenticated claim,
verification, status and commit requests bind the invitation and exact attempt.
Both peers protect their credentials before enabling sessions. Expired, cancelled,
forged or differently claimed invitations fail. Incomplete pairing requires
explicit repair; it cannot silently authorize access or replay an owner write.
Saved peers reconnect with fresh challenges and bounded sessions. Session hellos
must match saved endpoints.

## Guest catalogs

Paired desktop guest sessions negotiate `catalog-v1`, `artifact-read-v1` and
`plan-read-v1`. These routes use the peer
session credential in desktop main, never the publishing token or renderer
credentials. They are not general publication or plugin forwarding routes.

`POST /guest/catalog` accepts `{}` for a complete refresh or `{ "after": N }`
for a bounded change wait. `GuestCatalog` contains version 1, owner device ID,
increasing revision and source entries. An entry identifies the source tab
UUID, display title, `file`, `plan` or `folder` kind, supported content version,
and artifact metadata where applicable. Source filesystem paths, plugin state
and publication provenance are omitted. Built-ins, trash, incomplete sources,
unsupported kinds and guest references are excluded.

A reply is a complete snapshot, limited to 4096 sources and 8 MiB. Exceeding a
limit fails the refresh; it never truncates the source list. Waits return after
at most 20 seconds, with a 25-second idle limit and 30-second total deadline.
Reconnects request a complete snapshot. Receivers validate the complete reply,
authenticated owner identity, unique source UUIDs, kind/version support and
monotonic revision before applying it. A failed refresh preserves saved
references and makes content unavailable until a successful refresh.

`POST /guest/artifact-content` and `POST /guest/plan-content` accept a source
tab UUID and expected artifact revision. The owner resolves current active
eligibility before and after loading bytes and cancels an affected read on
source change or session revocation. Content uses a raw response, at most
32 MiB, with a 15-second idle limit and 60-second total deadline. The receiver
checks byte count and SHA-256 against the requested metadata. Plan content
retains the original structured document and renders through the registered native
plan view. Peers without `plan-read-v1` require an update. Unknown catalog versions or
kinds also require an update and never fall back to ordinary HTML.

### Guest source operations

Guest peers negotiate `mutations-v1`. The catalog's optional `sourceVersion`
tracks source publication, title, permanence and trash/restore changes; ordinary
reading, selection, hiding and scrolling do not advance it. Older catalogs remain
readable and require an update for source actions. Targets always include
`ownerDeviceId` and `sourceTabId`; names and artifact IDs alone cannot select a
remote owner.

`@irudd-scope/protocol/guest-operation` defines file/plan actions: `rename`, `retention`,
`trash`, `replace-plan` and `capture-basis` actions. Changes include the expected
source version and publication revision (zero for a source without an artifact).
Plan replacement and basis capture use the owner's current document and the same
validation and immutable-record rules as ordinary plan publication.

The local authenticated desktop API accepts POST JSON at:

- `/v1/guests/source`: `GuestTarget`, returning the current `GuestSource` or null.
  This provides the expected source version and publication revision for a new change.
- `/v1/guests/read`: `GuestRead`, returning `{ artifact, content }` from the owner.
- `/v1/guests/prepare`: `GuestChange`, returning `GuestOperation` after the owner
  allocates an identity and the receiver durably saves the input and identity.
- `/v1/guests/execute`: `{ target, operationId, digest }`. The receiver persists
  dispatch before sending the immutable operation. A second dispatch is rejected.
- `/v1/guests/status`: `{ target, operationId, digest }`, returning `GuestOutcome`.
  **Status settles a still-prepared operation as rejected.** That settlement and
  execution serialize in the owner database; a delayed execute cannot follow a
  definitive no-write outcome. Status is valid for a previously committed source
  Trashcan action even when the source is no longer shared.
- `/v1/guests/reconcile`: the same identity, returning `{ outcome, source }` after
  settling status and reading the current authoritative source (or null when no
  longer shared). It releases the receiver's dependent-write block. Starting any
  new change remains an explicit caller action.

The peer routes are `mutation-prepare`, `mutation-execute`, `mutation-status`
and `mutation-source` under `/guest/`; they require mutual consent and negotiated
capability. There is no arbitrary IPC, plugin callback, path or publishing-token
forwarding. Authentication supplies the caller identity, never the request body.
Source eligibility is checked inside execution. Receipt lookup requires current
peer authorization but does not require the source to survive.

The owner retains at most 4096 receipts for 48 hours. Live receipts are never
evicted; preparation fails at capacity and reclaims expired rows. A persisted maximum wall-clock value
prevents clock rollback from extending receipts; forward clock changes may expire
them. Execution never inserts a missing receipt, so unknown, expired and deleted
IDs cannot execute again. A lost reply requires same-ID status, never a fresh ID
or blind replay. Unknown outcomes retain receiver input until explicit current
source reconciliation. These transactions cover SQLite-owned data only; folder
filesystem writes use the separate host operation protocol.

### Guest folders

`@irudd-scope/protocol/guest-folder` defines explicit peer routes under
`/guest/folder-`. `list`, `read`, `events`, `search` and `info` negotiate
`folder-read-v1`; `version`, `upload`, `directory` and `status` negotiate
`folder-version-v1`, `folder-write-v1`, `folder-directory-v1` and
`folder-status-v1` respectively. Upload uses PUT; the other routes use POST.
A bounded base64url `Scope-Guest-Folder` header carries validated metadata.
Uploads carry raw streamed bytes without the artifact body limit.

Every access names `{ target: { ownerDeviceId, sourceTabId }, sourceVersion }`,
except status, which names `{ target, requestId }`. Listings add relative `path`
and `showIgnored`; reads add relative `path`, `start` and optional `end`, with
at most 8 MiB per preview and no end for a whole-file download. Searches add
`query`, `showIgnored` and optional `names`. Upload and directory requests include
the unchanged version 1 FolderOperationRequest. Caller identity comes from the
peer session; the owner obtains the root and hub from its own source tab.

The owner forwards the exact operation identity to FolderSource.operations at the
filesystem host. Actual remote adapters require `folder-operations-v1`; an old
hub returns an update requirement and never receives a legacy write instead.
Caller-bound owner bindings preserve status routing after an uncertain commit or
source removal. Status still requires peer authorization, never bypasses revoked
sharing, and returns the host's outcome rather than a desktop receipt. Unknown
or unresolved status never authorizes automatic retry.

Reads, uploads and downloads have a 60-second idle limit and a 12-hour total
limit. Other bounded requests use 20-second idle and 60-second total limits.
Search uses 35-second idle and 30-minute total limits; feeds send heartbeats every
10 seconds with a 35-second idle limit. Each peer has separate limits of 16 feeds
and 16 other folder requests. Event buffering is bounded to 256 events and 1 MiB;
an overflow disconnects the feed so the receiver re-lists. Source changes and
revocation cancel both hops. Existing handshake/header limits and ordinary
local/remote client write semantics remain unchanged.

### Owner-targeted plan commands

Existing `plan read`, `item`, `content`, `capture-basis` and `publish` commands
accept `--owner-device UUID --source-tab UUID` together. With these flags the
positional identifier must be the exact artifact ID, not its name. Reads return
`{artifact, document, owner}` with `owner` containing both target IDs and the
current `sourceVersion`. Packets include that owner and retrieval commands with
all three identity fields. No credential is included. Missing, offline, revoked
or mismatched owners fail without a local fallback.

Guest publication replaces an existing plan only. Both `--expected-revision N`
and `--expected-source-version N` are required, from an owner read. The CLI checks
the document and immutable history, then prepares and executes the existing owner
operation once. The owner validates again in its source/receipt transaction.
Writes return the exact operation identity, outcome and recovery commands.
Normal local commands retain their existing behavior.

`plan status ARTIFACT_ID` and `plan reconcile ARTIFACT_ID` use the same owner flags
and the receiver's saved operation. Status settles a still-prepared operation as
rejected, never executes it, and returns original input plus the current outcome.
Reconcile additionally reads current source state and releases the dependent-write
block. Inspect that result before deciding on another write. Keep the original
input after failures. Neither command allocates another identity or retries a write.

Authenticated `GET /v1/guests/capabilities` returns
`{capabilities:["guest-plans-v1"]}` when the receiver supports this workflow.
Paired hubs forward these routes only when the connected desktop advertises
`guest-plans-v1` in `Scope-Relay-Capabilities`; older hubs fail capability discovery
and require an update. Peer reads still require `plan-read-v1`; source lookup and
writes require `mutations-v1`. Guest routes are never queued or served from hub
metadata. The desktop and owner must be online.

`POST /v1/guests/pending` accepts `GuestTarget` and returns null or
`{artifactId?, operation, outcome, dispatched}` from receiver recovery. It makes no
owner request and changes no state. It can recover the saved identity after a lost
prepare acknowledgement. The other routes retain their existing contracts above.

Guest command requests and operation replies allow 34 MiB. `/v1/guests/read`
returns original UTF-8 content inside a JSON string, so its reply allows twice
`MAX_CONTENT_BYTES` plus `MAX_METADATA_BYTES` for JSON escaping and metadata.
The actual plan still cannot exceed 32 MiB, including retained bases and records.
Hub admission and streamed relay transfers enforce these separate limits. Commands
have a bounded 120-second client/relay deadline; peer operations retain their
60-second deadline. Desktop and stateless-hub HTTP body receipt has its own elapsed
120-second deadline for authenticated exact guest routes; ordinary routes retain
30-second body receipt and headers retain a separate 10-second limit. Progress does
not reset these deadlines. Incomplete timed-out input closes its connection before
preparation. These limits do not change ordinary artifact publication.
