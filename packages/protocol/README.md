# Artifact protocol

`src/index.ts` owns the validated wire types and limits. `src/client.ts` is the HTTP client used by CLI and desktop main. TypeScript types derive from Effect Schema definitions.

An artifact is the latest content and metadata for one stable ID. A revision is an increasing integer for that ID. A blob is immutable content addressed by its SHA-256 digest. An absent source field means unknown; it never blocks publication.

An optional `name` is a second unique, immutable key (lowercase letters, digits,
and dashes, at most 128 characters). Existing writers that omit it preserve it.
`GET /v1/names/:name` resolves the current artifact. Only named tabs support
external-agent conversations and native versioned diagram synchronization.

The desktop owns the API and persistent library. `LocalConnection` defines the version 1 discovery file with `endpoint` and `token`, validated as loopback HTTP. Its default path is `~/.config/irudd-scope/desktop.json`, overridable through `SCOPE_CONNECTION_FILE`. Desktop main writes it with mode `0600`; the CLI reads it when no endpoint or token override is supplied. Explicit endpoints require explicit credentials and never receive the discovered local token implicitly.

The paired hub forwards live requests and temporarily stores opted-in offline publications. Direct connections and stateless forwarding hubs require an available desktop. A failed response does not prove a write was rolled back; read the artifact and inspect the hub queue before retrying an uncertain publication.

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
connected Mac. Event heartbeats keep the connection active. Disconnecting
cancels every transfer and returns 503 where headers have not been sent.
Live requests end on disconnect. Offline publications can instead opt into
buffering by sending `Scope-Buffer-Publication: 1` on the tab reservation.
`ScopeClient.publishOrQueue` uses this option; `publish` retains synchronous
Artifact-only behavior. The hub issues its own tab ID, accepts one bounded
content upload, and returns 202 with `QueuedPublication` from the final PUT.
That receipt is `{ id, queued: true, expiresAt }`, with no desktop revision.
A reservation made offline continues using the hub queue if the Mac connects
before the upload finishes. Existing clients and older hubs keep working
online because reservation JSON and relay events are unchanged. Older hubs
return 503 offline.

The hub caps pending tabs, including incomplete uploads, at 50. Entries
expire 48 hours after reservation without retry extensions. Complete entries
deliver automatically on reconnect and survive hub restart. Delivery reads
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
Ordinary list and read requests, interactive diagram operations, speech, and
maintenance continue to require a connected desktop.

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

## Connected diagram agents

`src/diagram-agent.ts` defines `POST /v1/diagram-agents`. It uses the publishing
bearer token and the diagram request/response size limits. Paired hubs forward it.
Scope holds no agent runtime or host credentials. All connection state stays in
desktop memory, with at most four connections and one per diagram.

`wait` takes `id` and a display `name`. It verifies a loaded diagram tab, then
waits up to 20 seconds. The reply is `{ type: "idle" }` or a `request` containing
`id`, `requestId`, private `token`, `intent`, bounded `history`, and `diagram`.
Only an agent with an outstanding wait is available for new tab requests.
Closing that wait cancels availability. Repeat waits explicitly when idle.

`reply` takes `id`, `requestId`, `token`, `snapshot`, `message`, and `operations`.
The request credential is scoped to that diagram and one delivered request.
Edits use the normal snapshot check and autosave to the artifact after saving
the working draft. Empty operations
send only a message. Successful replies consume the credential. A stale edit
keeps the request available so the agent can inspect the current canvas before
responding. `release` with the same identity and credential ends the request.
The display name and artifact provenance are not authentication.

Delivered requests have a five-minute reply deadline. Cancel, tab close,
renderer reload, and desktop shutdown invalidate them. After delivery, the agent
may compute its reply without keeping an HTTP request open, within that deadline.
There is no offline request queue, automatic resume, replay, or agent launch.
Lost reply responses are ambiguous: inspect the draft before retrying.

## Native diagram synchronization

`src/diagram-sync.ts` defines `POST /v1/diagrams/sync`. The desktop uses the loaded
native Excalidraw canvas, including pending human edits. Requests require a
unique `name`. The optional hub forwards them, with the same authentication,
cancellation, and 32 MiB request bound. The 20-second diagram deadline and
one-command-per-artifact limit also apply.

| Action     | Input besides `name`               | Result                                            |
| ---------- | ---------------------------------- | ------------------------------------------------- |
| `read`     | Optional `since` version           | Full native document, or combined delta           |
| `status`   | None                               | Version and published revision                    |
| `write`    | `expectedVersion`, `delta`         | `applied` with normalization delta, or `conflict` |
| `replace`  | `expectedVersion`, `document`      | Same check, transmitting the full document        |
| `propose`  | `expectedVersion`, `delta`, `note` | Editable proposal for human acceptance            |
| `proposal` | None                               | Pending proposal, or null                         |
| `message`  | `text`                             | Assistant message in the named tab's conversation |

Versions hash the tab UUID and serialized native document. They include unsaved
canvas changes, while publication revisions describe persisted artifact updates.
Every write checks the version again after asynchronous document restoration.
A conflict is a typed `conflict` response, with the current version and a delta
when its base remains available. It is not an accepted write. The CLI exits 2.
While the human is drawing or editing text, mutations return HTTP 409 without
applying the request. Retry after that edit finishes; the version check still
applies. Reads remain available during the edit.

Deltas contain element property assignments/removals, deleted IDs, optional
element order, canvas settings, and changed assets. New elements replace their
entire record; existing objects receive property changes. Native Excalidraw
versions and required defaults are normalized by the editor. An `applied`
response's delta is relative to the submitted candidate, so clients update
their model without pulling it again.

The renderer retains at most 128 deltas and 2 MiB of delta history per tab.
Restart or history eviction causes a full `read` fallback. The native document
and a pending proposal persist in the tab's SQLite draft. Accepting a proposal
checks its base version; intervening edits require a new reconciliation.
Rejecting leaves the original document intact.

SSE adds `diagram` events with artifact ID, name, version, and an event kind:
`changed`, `message`, `proposal`, `accepted`, or `rejected`. Human edits and
embedded generation are on the human side; external agent writes do not echo.
These notices carry no full diagram. They are transient; reconnecting clients
check the version and rebase. There is no exclusive agent lease or model polling.

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
work, delete the shared key, or disable diagram generation.

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
kind are immutable, and a new inbox starts permanent. HTML updates retain the
repository binding and current review data. `POST /v1/pull-requests` accepts
the commands defined in `src/pull-requests.ts`; `ScopeClient.pullRequests`
validates requests and replies. Normal publishing credentials and connected
desktop requirements apply. Paired hubs forward the route without storing PRs.

`read` looks up a named tab and returns a complete snapshot with `tabId`,
`generation`, repository, viewer, sync status, and a flat `prs` array. All other
commands require that `tabId`, the immutable name, and a UUID `requestId`.
Repository configuration can be repeated with the same repository, but changing
it requires another tab. `sync` uses the desktop user's installed `gh` and
returns the current snapshot. Simultaneous refreshes of one tab share work.
Sync request IDs identify calls; they do not retain an inventory history.

PR facts include title, author, labels, draft status, requested reviewers, size,
commit IDs, merge status, aggregate checks, and
`hasUnresolvedConversations`. That flag is true when any GitHub review thread is
unresolved, false after a complete read finds none, and null when unavailable.
Checks and merge status identify their observed commits. Unknown values are
distinct from success or absence. A complete sync removes records no longer
open. Failed and partial reads preserve cached facts and local values.

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
Live events contain the artifact ID, name, and generation. They are transient
invalidations. Read a complete snapshot after reconnect or remount.

The CLI provides `pull-requests guide`, `read`, `configure`, `sync`, `detail`, and
`apply`. `apply` submits a validated JSON command file unchanged. Exported
snapshots and command files remain explicit local files.

### Authored HTML SDK

The host installs `window.scope.pullRequests` before authored scripts execute.
`watch(callback)` receives `(prs, context, sync)` initially and whenever the
durable snapshot or theme changes. It returns an unsubscribe function. Arrays
and their nested records are frozen. Context includes the tab name, repository,
GitHub viewer, and theme. Keep app UI state in memory and derive named views
with ordinary JavaScript predicates.

```js
const inbox = window.scope.pullRequests;
inbox.watch((prs, context, sync) => {
  const forMe = prs.filter((pr) => pr.requestedReviewers.includes(context.viewer));
  render(forMe, sync);
});
```

`sync()` requests refresh. `detail(nodeId, section)` returns the complete
commit-bound detail object; `section` is an app hint and does not limit that
reply. Local mutation methods require the version the user acted on:

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

## Named HTML plan review

Plans publish through the normal artifact API using `kind: "plan"`,
`mediaType: "text/html"` and a required immutable name. New plans start permanent;
updates retain later user choices. All plan commands use the normal publishing
credential and require a connected desktop. Hubs forward these routes.

| Route                                             | Behavior                                      |
| ------------------------------------------------- | --------------------------------------------- |
| `POST /v1/plans`                                  | Validated `PlanCommand`; returns `PlanReply`. |
| `GET /v1/plans/:name/images/:sha256`              | Download a PNG owned by that plan.            |
| `GET /v1/plans/:name/revisions/:revision/content` | Download retained HTML.                       |

`packages/protocol/src/plan.ts` owns the exact schemas. `read` returns metadata,
history, comments, rounds and responses in bounded pages; matching `since`
returns unchanged. A `next` cursor carries the review version and revision/record
positions. Continue with that cursor and the same filters. A changed version
returns 409 and requires restarting the read. Each page contains at most 100
revisions and 100 records, with JSON bytes checked before loading documents.
`roundId` selects one round and its comments/responses; `pending: true` selects
only pending rounds. These filters cannot be combined. `readPlanSnapshot`
collects consistent pages and retries changed-version reads up to twice.
Every mutation has a UUID `requestId`. The identical payload under that ID is
idempotent for the tab lifetime; different content returns 409. Writes return
compact `receipt` replies with artifact metadata, review version and an optional
created `recordId`. Created comment, round and response IDs equal `requestId`.
A comment has an
original screenshot, marked screenshot, normalized annotations, text and source
revision. Optional `viewport` metadata records `scrollX`, `scrollY`, `width`
and `height` in CSS pixels for placing marks over the same document revision.
Comments and drafts saved without this metadata remain readable; no database
migration is required. The desktop offers boxes and pins for new marks, while
existing arrow annotations remain supported by the protocol and screenshot renderer.
A submitted round contains distinct comments from one revision.
Responses must reply to every comment in that round. Optional HTML replacement
checks `expectedRevision` and commits with the replies. Text-only responses may
reference retained older revisions. Restore appends history rather than deleting
it. Seen, resolved and approved states are independent.

PNG limits are 8 MiB and 8192 pixels per dimension for each image. Command JSON
is bounded at 48 MiB, HTML at 32 MiB, comment text at 16384 characters, annotations
at 50, and comments/replies per round at 100. `ScopeClient` exposes `plan`,
`planImage` and `planContent`, validating replies and bounded byte streams.
Live events include compact `plan` notices for comments, round submission,
responses and review updates. Retrieve durable state after reconnect.

The CLI documents the agent workflow and schema with `irudd-scope plan guide`.
Feedback exports include `packet.json`, originating `plan.html` and both PNGs for
each comment. Export retrieves only the selected round, not the entire history.
They are explicit copies; plan storage stays in SQLite.
