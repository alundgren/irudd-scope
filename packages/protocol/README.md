# Artifact protocol

`src/transfer.ts` defines portable manifests and signed fifteen-minute
`scope-transfer://v2/` invitations for paired desktop copies. These contracts
also define the agent link-import request and receipt. Transfers support ordinary
artifact bytes, including Excalidraw files, which import as file tabs; they carry
no credentials, unique tab names, or plan and PR inbox records. Main validates
content sizes, media types, checksums, and Excalidraw document structure before
import. Invitations include a validated TCP port, signed together with the
connection address and lifetime. Version 1 transfer links are rejected.
Authentication and supervision of the user-installed Tailcat CLI belong to
desktop main; saved pairings are independent of invitation versions.

`POST /v1/transfers/import` accepts `{ "url": "scope-transfer://v2/#..." }`
with the normal receiver publishing token. Only tab links are accepted.
Main authenticates and inspects the manifest, downloads and validates its
content, then commits an independent copy. The reply is
`{ "artifact": Artifact, "alreadyImported": boolean }`; a same-link retry
returns the existing copy. The endpoint supports no pairing or link creation.
Browser-origin requests are rejected. Requests are limited to 16 KiB and
receipts to 32 KiB. The CLI, client and hubs allow a bounded 300,000 ms import
request; the signed invitation still expires after exactly fifteen minutes.
Imports require the receiving desktop online and are never buffered. A timeout
can occur after commit; retry the same link rather than requesting another copy.
Older desktops or hubs lack this additive endpoint and must be updated for
agent imports. Invitation versions, saved pairings and existing UI flows remain
compatible.

The receiver's agent runs `irudd-scope import-link 'scope-transfer://v2/#...'`
using its normal discovery or explicit authenticated endpoint. This command is
the explicit import action; it does not open a desktop confirmation dialog.

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

## Named HTML plans

Plans publish through the normal artifact API using `kind: "plan"`,
`mediaType: "text/html"` and a required immutable name. New plans start
permanent; updates retain later user choices. A plan has only its current HTML.
Read it with `GET /v1/names/:name` and `GET /v1/artifacts/:id/content`, which
paired hubs forward; `ScopeClient` exposes these as `named` and `content`. There
are no plan-specific routes, commands or live events. `irudd-scope plan content
NAME --output FILE` writes the current HTML to a new file.

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

Reads are bounded to the current results page, selected memory or proposal,
and ten completed summaries. Queues remain durable in SQLite. Restart interrupts
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
