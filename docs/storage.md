# Storage and recovery

Electron main owns Scope's persistent data. The first table gives macOS defaults.
Use the [development environment variables](development.md#isolated-development)
to select separate directories for development.

| Data                | Location                                                       | Contents                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact library    | `~/Library/Application Support/irudd-scope/artifacts/scope.db` | Active, queued, and trashed tabs, retention timestamps, published metadata, content references, bytes, the Sketchpad drawing, retro reports and independent session tracking.                      |
| Desktop preferences | `~/Library/Application Support/irudd-scope/desktop.db`         | Appearance, provider settings, workspace groups and selection, remote, retro and memory configuration, retained speech receipts/audio, and the latest harness scan per machine.                    |
| Provider API key    | macOS Keychain                                                 | One credential entry per desktop profile.                                                                                                                                                          |
| Remote credentials  | macOS Keychain                                                 | Connection tokens keyed by hub ID, in the desktop profile's credential entry.                                                                                                                      |
| CLI discovery       | `~/.config/irudd-scope/desktop.json`                           | Versioned loopback endpoint and publishing token, mode `0600`.                                                                                                                                     |
| Hub settings        | `~/.local/share/irudd-scope/hub/hub.db` on the remote          | Hub identity, listener configuration, credential hashes, pairing expiry, remote update status, memory configuration, buffered publication bytes/metadata, and recently observed artifact metadata. |
| Memory clone        | `~/.local/share/irudd-scope/memory/NAME` on macOS and Linux    | The user's git working copy of their personal irudd-okf repository. GitHub holds the shared copy.                                                                                                  |

Windows 11 x64 uses an independent profile with these defaults:

| Data                                      | Windows location                           |
| ----------------------------------------- | ------------------------------------------ |
| Artifact library                          | `%APPDATA%\irudd-scope\artifacts\scope.db` |
| Desktop preferences                       | `%APPDATA%\irudd-scope\desktop.db`         |
| Provider, remote, and pairing credentials | DPAPI-encrypted record in `desktop.db`     |
| CLI discovery                             | `%LOCALAPPDATA%\irudd-scope\desktop.json`  |
| Memory clone                              | `%LOCALAPPDATA%\irudd-scope\memory\NAME`   |

The `windows-credentials` preference row stores a version 1 document containing
only encrypted base64 ciphertext. Electron's `safeStorage` protects it with
Windows DPAPI for the current Windows account. Credential decryption and use
stay in desktop main. Encryption or decryption failure reports an error; it
never falls back to plaintext. This optional preference row does not change
the desktop database schema version. Mac and Windows profiles are independent;
Scope does not migrate or share them between platforms.

On Unix, Scope creates database directories with mode `0700` and database files
with mode `0600`. Windows uses the current user's profile directories and
their Windows access permissions. Treat the whole profile and discovery file as private. Explicit
imports and downloads use files; ordinary storage uses SQLite.

Certificate-signed Mac installations access the existing Keychain entry through
the bundled **Scope Credentials** helper. The service name, profile account,
and credential JSON remain compatible with direct Keychain access. Approving
the helper changes access permission, not the stored provider key or remote
tokens. Changing the executable that accesses this entry may require another
Keychain approval.

Closing an individual tab moves it to Trashcan and retains its content and state.
The Sketchpad stores one `tab_drafts` row with Excalidraw's local serialization
and its zoom and pan. That serialization omits deleted elements and images no
element uses, so removed images leave storage on the next save. An empty canvas
has no row: deleting every element removes it, and Reset canvas removes it when
its ten-second undo window ends, the person leaves the tab, or Scope quits. SQLite reuses
the freed pages; the file shrinks during regular maintenance. A draft over
32 MiB is not saved and the Sketchpad shows an error.
Quitting Scope, closing its last window, updating, and restarting preserve tabs
that remain open. Pending edits flush before application shutdown.

Every publication commits a queued tab before accepting content or metadata.
Tab-owned records reference that tab in `scope.db`. Tabs store a permanence
flag, last-visible timestamp, and nullable trash timestamp. The trash timestamp
takes precedence over permanence. Restoring clears it, keeps the previous
permanence, and resets visibility time. Tab documents also retain an optional
`hidden` field. Closing a permanent tab sets it and moves the tab to the end of
the saved order. Hidden tabs remain in the workspace and preserve drafts, but
cannot be selected until reopened. Existing documents without `hidden` remain
visible. Built-in plugin categories always retain permanence, cannot change
type, and cannot move to Trashcan or expire. Reopening uses the saved tab UUID
and state rather than creating another tab for the same built-in type.
Late workspace saves cannot clear trash
or recreate deleted rows. Draft saves can preserve a write already in progress
when a tab moves to Trashcan, but cannot insert a deleted tab.

Temporary tabs become trash after 24 hours outside the visible tab strip; the
selected fullscreen tab counts as visible. Hidden and minimized windows do not
refresh visibility. Checks run after startup and every minute while the renderer
is running, after pending saves flush. A failed flush defers cleanup. Trash gets
seven days from the actual transition, including after a long absence. Permanent
tabs never expire while active. Returning a permanent tab to temporary starts a
fresh 24 hours. Sleep or a stopped app delays collection until Scope runs again.

Trash retains artifact names, bytes, drafts, conversation, and saved viewport.
Agent writes to trash fail and require restoration in Scope. Artifact read and
list APIs include trash. Emptying Trashcan deletes all confirmed entries,
including entries hidden by a search. Entries restored since confirmation
survive. Deletion removes the tab, metadata, references, and drafts in one
transaction. A crash leaves either the retained records or complete deletion.
Shared bytes remain while any tab references them. Workspace selection and
groups remain separate application preferences. HTML's unsaved in-page state
survives tab switches while mounted, but is not persisted through trash or restart.

## Reclaiming disk space

Uploads and unsuccessful updates retain content references for fifteen minutes
after upload. This covers the gap before metadata publication, including content
shared with another tab that closes in the meantime. An abandoned publication's
queued tab expires after its staging references expire. Successful publications
open automatically, including after restart, without a fixed tab count limit.
Permanent deletion removes tab-owned content. Upload cleanup runs at startup,
during shrink, and at one-minute maintenance checks. A shrink receipt reports bytes
still protected by staging; it does not claim those bytes were reclaimed.

Editor saves replace content and metadata in one transaction. Replaced editor
snapshots are released immediately. External uploads still receive their
fifteen-minute staging protection, including an initial native-file import or
an upload that shares bytes with an editor snapshot.

Automatic shrinking applies independently to `scope.db`, `desktop.db`, and a
paired hub's `hub.db`. A database is eligible when its main file plus WAL is
strictly above 100,000,000 bytes and at least 24 hours have passed since its last
successful shrink. A database without a recorded success is due when large
enough. Startup, system resume, and one-minute checks re-evaluate eligibility.
Skipped checks and failures do not advance the successful timestamp. A manual
success does. Filesystem allocation is measured separately in receipts.

```sh
irudd-scope delete ARTIFACT_ID --timeout-ms 120000
irudd-scope shrink --timeout-ms 120000
irudd-scope hub shrink --timeout-ms 120000
```

`delete` is idempotent and returns `{ "id": "ARTIFACT_ID", "deleted": true }`,
or `deleted: false` when already absent. It removes every tab referencing the
artifact. `shrink` reaches both desktop databases through the normal discovered
endpoint, including a paired hub. `hub shrink` reaches only the local hub and
works with the desktop disconnected. A stateless forwarding hub has no database.

Manual shrink bypasses size and interval gates. SQLite VACUUM runs in a separate
process, with bounded lock waits, a deadline, and checkpoint result checks.
Writes may wait or report busy while their database is being vacuumed; the
desktop and relay event loops continue running. SQLite may require twice the original
database size in temporary space. Insufficient space, busy databases, and
interrupted work return deferred or failed receipts without replacing the
database. See [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) and
[checkpoint behavior](https://www.sqlite.org/wal.html).

Receipts identify each database, main-file and WAL bytes before and after,
allocated bytes, duration, completion status, last successful time, and any
reason or deferred staging bytes. Requested work that does not complete exits
nonzero. Recording the receipt can leave a few WAL pages after the shrink.
A caller disconnect does not replay the operation; maintenance continues
up to its supplied deadline, bounded at ten minutes. Inspect the latest receipt
with `irudd-scope shrink --status` or `irudd-scope hub shrink --status` before
retrying. If a database lock prevents saving a receipt, that result is available
in the running process until restart. A process interruption before recording
success leaves the database eligible for retry.

## Backup and restore

Remote records share `desktop.db` with other preferences. Their tokens stay in
Keychain on macOS or in the DPAPI-encrypted Windows credential record. Removing
a remote revokes the credential on the hub before removing the desktop's saved
record and token. If the hub is unavailable,
the record stays disconnected so removal can be retried. Linux desktop
development keeps connection tokens in memory; after restart, re-pair using
`irudd-scope hub unpair` and `irudd-scope pair` on the remote.

The hub uses the same private discovery format as local desktop publishing,
with its own publishing token. Do not share one discovery file between a hub
and a desktop on the same host. Set `SCOPE_CONNECTION_FILE` to separate paths.
Hub state includes undelivered publication bytes and metadata. CLI publications
persist there even when the desktop is connected; delivery failures retain them
until delivery, discard, or expiry. Back up its
database and discovery file together if you need to retain pairings and
pending publications. The paired hub retains at most 50 entries including
incomplete uploads, with at most 32 MiB content each. Full queues reject new
entries. Expiry is fixed at 48 hours from reservation, and retries do not
extend it. Cleanup runs at startup, on queue access, and every three seconds
while the hub runs. A stopped hub cleans up when restarted. Delivery, explicit
discard, expiry, and unpairing delete the queued row and bytes. Deletion is
logical, not secure erasure; SQLite maintenance reclaims freed pages and
backups can retain expired content. A lost delivery acknowledgement is
reconciled against the desktop before retrying; conflicts retain the queued
content and an error for inspection. Never restore an old hub backup against
a different desktop pairing. Installation builds and skill files
contain program code and live separately from this state. The desktop installers
bundle skills with each app build. Migrated skills CLI copies, including
local edits, remain in `skill-backups/` under the desktop installation directory;
these backups are not artifact or preference storage.

Remote build metadata records its commit and installation paths alongside the
bundled code. The hub's SQLite update record retains the target commit, phase,
and failure message across restarts. Updating the remote tools does not replace
its database or discovery file. The updater retains the previous build for
startup recovery. This restores program files, not the hub database.

Quit Scope before copying `scope.db` and `desktop.db`, or use SQLite's online
backup API for each database. Copying only a database file while Scope runs
can omit committed data in its WAL file. Restore both databases with Scope
closed. Mac provider keys stay in Keychain and are not part of these backups.
Windows backups include the encrypted credential record in `desktop.db`.
Restoring it requires the original Windows account's DPAPI access. A database
copy alone does not transfer credentials to another account or computer.

The discovery file is needed by local publishers. Keep a private copy if you
need to preserve the publishing token. Deleting it with Scope closed causes
the next launch to generate a new token; remote callers must then use that
token. The library and preferences remain intact.

## Supported data imports

Scope reads artifact schema version 9, desktop schema version 7, and hub schema
version 4. It rejects
newer schema versions. Back up the complete data directories before an upgrade
when you need the option to return to an older desktop.

Hub schema 4 adds a bounded cache of recently observed artifact metadata
alongside buffered publication storage, preserving existing configuration,
pairing hashes, and pending publications. Saved metadata expires after 48 hours
and is cleared on unpairing. Older hubs reject schema 4; restore a
pre-upgrade backup to downgrade. The relay protocol remains compatible
with older Macs. Older clients do not opt into offline buffering and keep
returning an outage error.

Artifact schema 5 adds retention columns to the tab table. Existing tabs keep
their IDs, order, names, and drafts and begin as temporary with a fresh visibility
timestamp. Schema 4 introduced the unique index for optional tab names. Older
builds reject schema 5; restore a pre-upgrade backup to downgrade.

Scope no longer has diagram tabs. On startup it permanently deletes saved tabs of
type `diagram`, including hidden and trashed ones, with their artifacts and
drafts, in one transaction. Other `.excalidraw` artifacts open as downloadable
files. The legacy `diagram_drafts` table in `desktop.db` is no longer read or
created; an existing table is left in place. A paired hub may keep metadata for
a deleted diagram for up to 48 hours; an offline update to that ID fails on
delivery and stays visible in `hub queue`.

For an artifact directory containing a database and a `blobs/` directory,
Scope verifies hashes, sizes, and referenced content before importing bytes
into SQLite in one transaction. It removes verified content files after
commit. Missing or corrupt content stops migration and retains the database
and files. To move such a library, stop every process using it, copy the
complete directory, and set `SCOPE_DATA_DIR` to the copy. Do not merge it with
a nonempty library or run two stores against it.

Settings JSON versions 1 and 2 import into `desktop.db`. A saved diagram
generation preference is ignored. Existing Keychain keys are
retained. Encrypted provider keys in legacy JSON require macOS secure storage
and migrate directly to Keychain on the first shared-key operation.
Startup imports ordinary preferences without accessing credentials. The legacy
JSON remains until its key has migrated, including across restarts and failed
access attempts. It is removed only after the replacement is saved. Obsolete
connection settings are discarded.
Existing artifact-ID tab lists first acquire stable tab and group UUIDs in
`desktop.db`. On startup, Scope imports saved open tabs into
`scope.db`, then removes the old workspace document from `desktop.db`. Workspace views use version 3. Order, selection, groups,
non-tab preferences, and unknown open plugin records survive. Artifacts referenced
only by old closed history are deleted; an artifact still referenced by an open
tab survives. Other existing library items receive queued tabs.

The import records completion in `scope.db` in the same transaction as the
imported records. If startup stops before the old desktop records are removed,
the next startup finishes removing them without importing twice or restoring a
deleted tab. Both databases must be backed up together before an upgrade.
Clients must use the tab-first publication protocol; upgrade desktop, CLI, and
hub together. CLI publication commands retain their syntax.

These import paths support existing data. New writes use the stores listed
above. Restore the complete backup before using a desktop that cannot read
the upgraded schema.

## Folder tabs

A Folder tab stores only its tab record in `scope.db`: the machine ID,
canonical folder path, expanded folders, filter text, ignored-files setting,
selected file, the lines an agent marked in it, and a change counter.
`folder select` writes the selected file, its marked lines, and expanded
folders into this record. The `folder_tabs` table keys each tab by
machine and path and is removed with the tab. Scope stores no file bytes or
file lists in `scope.db`, `desktop.db`, or `hub.db`. The filter's path list,
content search results, and previews stay in memory only and end with the tab's
view. Dropped and saved files stream between the two machines without being
stored; only a staged `.scope-partial-*` file exists at the destination while a
copy runs. Restored tabs show the
folder's current contents. Trashing a Folder tab keeps only its record.

Versioned folder operations retain a bounded `folder-operations-v1` journal
in the filesystem host's existing SQLite database: a desktop `preferences` row
for local files, or a hub `settings` row for remote files. Adding this optional
row preserves existing databases and their schema versions. It contains hashed
caller/request identity, a command fingerprint, expiry and outcome, never file
bytes or plaintext credentials. Host writes serialize the entire read/update
sequence; desktop preference writes also use the store's existing queue.

The journal retains at most 4096 outcomes for 48 hours from each request ID's
embedded timestamp. New admission prunes expired outcomes and durably advances
a time floor in the same document. Database shrinking preserves this ordinary
row and its floor. Expired IDs are rejected after restart and clock rollback.
A full journal rejects new operations instead of discarding unexpired receipts.

Intent is saved before filesystem changes and completion before the reply.
Interrupted intents remain unresolved without replay. A process crash can leave
hidden `.scope-partial-*` files; matching file bytes alone are not proof of a
completed operation. Resolve uncertain outcomes by status lookup and inspection,
not by automatically issuing another write. Removing the database or restoring
an older backup also removes its newer operation evidence; clients must treat
missing status as uncertain. Folder files remain authoritative on their original
filesystem and are not replicated into SQLite.

## Harness scans

The desktop's `harness_scans` table in `desktop.db` keeps the latest harness
scan for each machine: one row per machine key (`local`, and later
`remote:ID` and `guest:ID`) with a JSON document that SQLite checks with
`json_valid` and a 262,144-byte limit. The document is the scan that
`irudd-scope harnesses read` returns, including `scannedAt`. It holds names,
versions, sign-in state, folder sizes and instruction file fingerprints; it
never holds tokens, keys, MCP commands, URLs, headers or environment values,
account emails or names, or instruction text. A scan larger than the limit is
not saved and the previous one stays.

The table is created with `CREATE TABLE IF NOT EXISTS` and does not change the
desktop database schema version, so older Scope versions open the database and
ignore it. A saved scan that no longer validates is ignored and replaced by the
next scan. The desktop scans at every start, so deleting the table or its rows
loses nothing that a scan cannot rebuild. Scope never writes in the harness
folders it reads.

## Speech requests

The desktop-main `voice/` module owns `voice_requests` in `desktop.db`. Each row
contains a caller request ID, a versioned SHA-256 of normalized narration and speech settings,
expiration time, validated JSON receipt, and optional WAV bytes. Narration itself
is not retained. The receipt retains OpenRouter's generation ID when returned.
Credentials use the desktop credential store: Keychain on macOS, DPAPI-encrypted
SQLite on Windows, and process memory on Linux or explicit session overrides.

New payload hashes have a `v2:` prefix and include the effective Aoede voice
and conversational instructions when callers omit settings. Existing unprefixed
Kore hashes still match their original requests for recovery without generation.
No table migration is required. Receipts now accept Aoede and Leda as well as
Kore; a desktop that only accepts Kore cannot open those new receipts. Restore
a backup from before generating with the added voices when downgrading to it.

Requests, receipts, and audio expire 24 hours after submission. Scope has no
retained request count limit or separate database byte quota. Provider responses and downloads are bounded to
16 MiB each. Expired rows are deleted on startup, submission, and once a minute
while running. The normal desktop database maintenance reclaims deleted bytes;
expiry is logical deletion, not secure erasure. Backups can retain expired data.
Audio and receipt files written by the CLI are explicit agent exports.

Completed requests survive restart. A saved generating request becomes
`interrupted` at startup, preserving its ID and known generation metadata without
resubmitting to OpenRouter. A crash after provider acceptance can leave the charge
unknown and the audio unavailable. Scope never automatically regenerates.
Schema version 7 adds the table and the optional, default-off
`voiceGenerationEnabled` setting without changing existing preference fields.
Older desktops reject this newer database; restore a compatible backup to downgrade.

## Plans

Structured plans store their versioned JSON in the artifact/blob tables. Exact
proposal bases, including authored HTML, remain inside the current document so
normal reclamation cannot erase the meaning of recorded agreement or evidence.
Bases cannot be redefined or removed. Record correction requires explicit removal
IDs and new record IDs. The 32 MiB artifact limit includes all retained material;
publication fails instead of discarding old records.

Artifact schema 16 converts legacy HTML plans to ordinary HTML, preserving bytes, artifact
IDs, names, titles, permanence, tab order, hidden/trashed state and saved workspace
fields. Conversion is idempotent and also reconciles imported legacy workspaces.
Late HTML publishers create ordinary HTML; structured plans reject HTML downgrades.
Older desktops reject schema 16. Restore a complete pre-upgrade backup to downgrade.
Use the matching desktop and CLI for JSON plans. `plan content` exports authored
HTML to a new file and refuses overwrite.

Schema version 15 removes the plan history and feedback tables that earlier
builds kept: `plan_state`, `plan_revisions`, `plan_images`, `plan_records`,
`plan_receipts` and `plan_drafts`. Old plan versions, comments, screenshots,
feedback rounds, agent responses, approvals and unfinished comment drafts are
deleted. Each plan's current HTML and tab stay. The tables go during the
upgrade; the old HTML and screenshot bytes are deleted by the next maintenance
check, which runs at startup, and disk space is returned by the next shrink.
Older builds reject schema 15. Back up the complete databases before upgrading
if the old feedback matters; restore that backup to downgrade.

## Pull request inbox data

Artifact schema 7 adds tab-owned repository state, current open PR records, and
mutation receipts to `scope.db`. It preserves existing artifacts and workspace state. Older builds reject this schema. Restore a complete
pre-upgrade backup to downgrade.

GitHub facts, local notes and snoozes, inspection and review baselines, and
current agent assessments persist independently of the authored HTML revision.
Inbox tabs are built-in: closing hides the tab and keeps this data, and the tab
cannot move to Trashcan. Deleting the inbox artifact removes the data through
foreign-key cascades. A successful complete sync removes PRs no longer
open and their associated local records and receipts. Failed or partial syncs
keep the cached list. Scope retains no closed PR archive or earlier PR snapshots.
When a complete sync observes a different commit for the same PR, it clears a
snooze that has wake-on-new-commit enabled and increments the snooze version.
Ordinary snoozes and updates on the same commit remain unchanged. The commit
comparison uses the snooze's captured commit and the latest saved local state
inside the inventory transaction, so notes and review baselines stay intact
and an older Undo cannot restore a cleared snooze over newer state.
Startup turns an interrupted saved refresh into an error with a retry action,
preserving the cache and last successful sync time.

Local mutation receipts retain request IDs and payload hashes for the owning
PR's lifetime, or the tab lifetime for repository configuration. Identical
retries do not repeat the write; changed payloads under the same ID conflict.
Every command except a name lookup pins the saved tab UUID, so a command for a
deleted tab cannot modify a new tab that reuses its name. Exported command and
snapshot files are explicit copies and are not Scope's persistent store.

Artifact schema 9 adds the inbox-owned JSON `appState` value and its version
to `pull_requests_state`. Existing inboxes start with an empty object at
version 0 and retain their repository, PRs, local values, and receipts. State
mutations use tab-owned receipts and persist separately from the HTML revision.
Complete syncs and PR removal preserve it. Deleting the inbox cascades through
its owning row and receipts. Older builds reject
schema 9. Restore a complete pre-upgrade backup to downgrade.

Artifact schema 10 adds `pull_requests_pr_state`, keyed by inbox tab UUID and
PR node ID. Existing root state and PR records are preserved. Each PR starts
with an empty object at version 0 and gains a row on its first write. Per-PR
state has no storage byte quota; the root inbox object retains its 32 KiB limit.
It survives commit changes, HTML updates, restart, and closing the tab.
A complete sync removing a PR deletes its state through the current PR's
foreign key, and deleting the inbox removes all its PR state. Mutation
receipts follow the same PR lifetime. Older builds reject schema 10; restore
a complete pre-upgrade backup to downgrade.

Artifact schema 13 makes every inbox tab a permanent `pull-requests` tab. Saved
tab documents with another type switch to `pull-requests`. An inbox that was in
Trashcan leaves it as a closed tab at the end of the drawer, keeping its
repository, PRs, notes, and state. Older builds reject schema 13; restore a
complete pre-upgrade backup to downgrade.

## Retained external publication records

Artifact schema 8 retains the `publications` table and its referenced HTML bytes
for compatibility with existing profiles. These records are inactive. Scope has
no external publication controls, commands, or API and does not resume saved
operations. Remote artifacts and Sites remain with their provider.

Artifact updates and storage maintenance preserve these records and their bytes.
Closing or trashing a tab retains them until permanent deletion of the owning
tab removes them. Include `scope.db` in backups to preserve the stored records.
Older builds that support only schema 7 reject these databases; restore a
complete pre-upgrade backup to use those builds.

## Retro reports and tracking

Schema 11 adds retrospective report and tracking tables without removing
existing data. Desktop builds that support only schema 10 or earlier reject
this database after upgrade; restore a complete pre-upgrade backup to use an
older build.

Schema 12 expands initialization modes to include `from-date`, preserving all
existing initialization rows and cutoffs. Builds supporting only schema 11 reject
the upgraded database; restore a complete pre-upgrade backup to downgrade.

Retro review records belong to their tab in `scope.db`: normalized session
inventory, findings, decisions, notes, requests, applied outcomes and authored
JSON state. Native transcripts remain on their source hosts. Reports may
contain short evidence excerpts and metrics with their methods and coverage.

Separate source/runtime records persist audited native session IDs, first-use
initialization, Start now and historical cutoffs and recorded retro-agent identities. They
have no foreign key to a report tab. Finishing writes the final review status
and successful tracking updates in one local transaction. Unavailable sources
and unfinished retros do not commit reviewed-session markers or initialization.
Publishing a report records its explicit retro-agent exclusion even if the
retro never finishes. Whole audited sessions remain skipped after resumption.

History opens the tab's retained final HTML and decisions. Closing a permanent
retro preserves it. Trash follows normal retention; deleting its content
removes its history entry without removing tracking or source preferences.
There is no hidden second report copy. Finished report content and review
state are immutable.

Source names, SSH aliases, runtime roots, canonical origin inclusion choices,
and optional memory destinations are desktop preferences in `desktop.db`.
They contain no SSH credentials. Back up both desktop databases to retain
configuration and tracking. Restoring an older backup can repeat a review.
Tracking is owned by one Scope desktop and is not replicated through paired hubs.

## Memory library

The `memory` preference row in `desktop.db` retains the enablement switch,
optional local bundle root, optional `OWNER/NAME` repository and Git sync switch,
and each machine's last observed personal bundle location. Existing rows retain
their fields and default to their previous repository sync behavior. A
`librarian-memory-recovery` preference preserves the original memory settings
before Librarian initializes. Local bundle locations need no Git or remote.
Scope never deletes or migrates their files when connecting or disabling memory.

The `librarian` preference stores the selected view and full dreaming run queue,
completed history, evidence and weekly reminder dates. `librarian_receipts`
stores a request ID, payload hash and bounded response in one transaction with
the state for agent commands and human decisions; view navigation stores none.
Session capabilities remain in process memory; neither receipts nor payload
hashes restore authority after restart. An active persisted run becomes
interrupted at startup and requires an explicit user-requested resume.

The `librarian` preference also keeps each Librarian view's place: Browse
filters and page, the shared selected memory, the back trail, the result page
beside the reader, filter facets and the Connections, Stages and Activity
settings. Older builds reject a document with these fields and quit at startup;
restore a complete pre-upgrade backup to downgrade.

Librarian retains the memory built-in tab identity. Version 1 tab state migrates
to version 2 with the original document and recovered draft kept together in
`scope.db`. A tab becomes version 3 when it first saves its views' scroll
positions; older builds then show an error inside the Librarian tab. The draft remains inspectable and copyable even with memory disabled
or its old repository disconnected. Other tabs, groups, preferences and saved
selection retain their existing contracts.

irudd-okf owns portable Markdown, bundle identity and immutable proposal/review
history in the selected folder. Scope stores workflow and human decisions,
then delegates revision and source validation to the CLI. Rejection and undo
use the file engine's contracts. Failed decisions retain displayed content;
there is no renderer localStorage or persistent filesystem cache.

Optional clones live under `%LOCALAPPDATA%\irudd-scope\memory` on Windows,
`~/.local/share/irudd-scope/memory/` on macOS and Linux, or `SCOPE_MEMORY_DIR`.
Portable OKF manifests and review history sync with Markdown. Runtime files
under `.irudd-okf/` and `.okf-*.tmp` stay local. Scope holds the OKF writer lock
during Git changes. Unknown locks or unfinished rebases remain for explicit
recovery. Turning memory or Git sync off leaves bundle files and repository
history intact. CLI request files are private, temporary and removed afterward.

## Prompt library

`scope.db` stores one current prompt workspace, independently revised library
items, original PNG/JPEG/WebP image bytes, and mutation receipts in the
`prompt_state`, `prompt_items`, `prompt_images`, and `prompt_receipts` tables.
Schema initialization is additive and preserves existing artifacts. Prompt rows
are independent of artifact tabs and remain when a viewer closes. Item deletion
removes its image reference and detaches current selections in one transaction,
preserving copied workspace text. Unreferenced prompt image bytes are removed.
Reset clears only the current workspace. Library edits never rewrite its text.
Retained successful creation receipts reserve item IDs after deletion, so an old
revision cannot update a replacement under the same ID. New items need new UUIDs.

Include `scope.db` in the existing backup procedure. Older Scope versions that
cannot read schema 14 reject this database; restore a matching backup before
downgrading. Example images are at most 8 MiB and 4096 pixels per dimension;
accepted formats are PNG, JPEG and WebP. Bytes stay original in SQLite.

`irudd-scope prompts export --output NEW_FILE.zip` writes a versioned,
library-only ZIP from one consistent database snapshot. Its manifest, library
records, structure definitions and referenced images exclude the current
workspace and all other Scope content. Separately authored example-scene
metadata belongs to its library item. Export refuses an existing output path
and libraries above the 128 MiB export bound. There is no ZIP import.

Guest identity and peer display metadata use the `guest-device` and `guest-peers`
preferences in `desktop.db`. Guest consent, the reserved listener port and local
Tailscale address use `guest-settings`. Guest pair secrets and peer endpoints use
`guestPairs` in the protected credential document. Protected storage succeeds
before a peer record can be saved, and pairing leaves access disabled until both
sides confirm consent and credential storage. At most 32 guest peers are retained.
Forget removes only the selected guest credentials and peer metadata; provider
keys, hub tokens, ordinary artifacts and guest recovery data remain intact.

Invitations, attempts, challenges and session tokens are memory-only. Invitations
expire after five minutes and admit one claimant. Session tokens are invalid after
restart; compatible saved peers negotiate fresh sessions using the same identity,
address and port. Changed endpoints require explicit fresh pairing. Session-only
credential profiles require pairing again after restart.

Cancelling an incomplete pair saves consent off and sets its protected confirmation
to false, retaining the key, endpoint, peer metadata and recovery data until Forget.
Success requires both writes. A failed cancellation stays retryable and must be
resolved before restarting; it does not claim durable revocation when storage is
unavailable. A stale enabled preference alone cannot authorize an unconfirmed pair.

Protected credential reads discard obsolete pairing key and endpoint fields before
strictly validating retained provider keys, hub tokens and current guest pairs.
Reading leaves protected bytes unchanged. The next successful credential update
writes retained fields only. Invalid retained credentials still fail explicitly.

## Guest references

`desktop.db` adds `guest_tabs`, keyed by a receiver UUID and a unique owner
device ID/source tab UUID pair. Each row stores projected source metadata and
the receiver's own tab navigation. `guest_catalogs` retains the last accepted
revision and source fingerprint per owner. Equal revisions must carry identical
source metadata. These additive tables do not change existing local tab
records. Source metadata refresh preserves the receiver UUID and navigation.
Missing sources remain references but are unavailable for content reads.

The `guest-catalog-version` preference stores the owner catalog's revision and
metadata fingerprint together. Revisions increase when that complete projection
changes and survive normal restart. A receiver rejects older revisions and
keeps its last valid records after failed or incomplete refreshes. Restoring an
older owner database can roll back its revision and requires resolving that
mismatch before the receiver accepts it.

Guest records and content never enter the receiver's `scope.db`, blob tables or
retention records. There is no persistent guest content
cache. Published bytes remain in the owner's `scope.db`; folder files remain on
their existing filesystem. Credential storage remains separate from these
metadata records. Exported guest downloads are ordinary user-selected files.

Receiver workspace layout includes an optional ordered UUID list interleaving local
and guest tabs. Existing layouts without it restore their previous local order,
then guest order; the next workspace save records the combined order. New tabs
append after saved entries. Guest navigation and layout save together in a
`desktop.db` transaction. A failed write remains in the workspace flush/quit
recovery flow.

Guest tab documents also accept an optional `guestReadRevision` marker, separate
from plugin state. File guests keep scroll coordinates in `state.data.fileScroll`.
These fields contain only receiver preferences, never owner bytes or source
edits. Older builds ignore the optional fields and may lose those preferences
when saving; no database schema version changes. Hidden guest UUIDs remain
reopenable after restart, and owner restore reuses the same reference.

## Guest changes and recoverable input

Artifact schema 17 adds `live_tabs.guest_version` and source-version triggers.
The additive `guest_operations` table in `scope.db` stores caller-bound prepared
identities, payload digests, expiry and outcomes. A terminal outcome and its source
mutation commit in the same transaction. Receipt records survive source deletion.
The `guest_clock` lifecycle counter retains the maximum observed owner time.
Receipts expire after 48 hours; a 4096-receipt limit rejects preparation rather
than evicting live outcomes. An older desktop cannot open artifact schema 17.

Receiver `desktop.db` adds `guest_recovery`. Action drafts and HTML field input
are qualified by guest UUID, owner device, source UUID and publication revision;
HTML also records the blob identity. These are not imported artifacts or an
HTML cache. Each input record allows 64 fields, 8192 characters per value and
64 KiB encoded JSON. The combined draft budget is 16 MiB and 4096 records.
Failures remain visible and participate in the existing close/quit save barrier.
Scope does not truncate or automatically evict input. Explicit discard removes it.

Pending operations have a separate budget: at most four receiver operations,
each up to 34 MiB encoded JSON, preserving the existing 32 MiB plan content
limit independently of the form budget. The receiver saves its submitted input,
owner target, expected versions, operation identity and outcome before dispatch.
These records persist through restart and block further changes to the same guest
until status and the current owner source are reconciled. They are recovery input,
not an offline write queue; reconnect never dispatches them automatically.

HTML recovery covers edited ordinary input, textarea and select controls with a
unique ID, name or accessible label. Password, file, hidden, email, telephone,
autocomplete credential/payment/identity fields, sensitive identifiers,
`data-scope-recovery="off"`, contenteditable, script state, ambiguous identifiers
and cross-origin documents are excluded. Restore is explicit and requires the
same owner, source, revision and blob; it assigns values without submitting forms
or firing authored input handlers. Changed revisions retain old values for copy
or discard. Arbitrary HTML runtime state and DOM bytes are never serialized.
Interactive HTML remains trusted and can make network requests independently.

Form recovery remains accessible when the owner replaces HTML with another
revision or content type. Unsaved working values stay in the guest's current
window, including values exceeding storage limits. They are labelled unsaved
and can be copied or explicitly discarded; they are not restart-durable until
the bounded recovery write succeeds. Discard waits for earlier writes and
prevents queued snapshots from restoring discarded input. Retention and source
Trashcan changes preserve unsubmitted title drafts. A completed matching rename
or explicit title discard clears that title draft.

Folder guest navigation is saved under the guest tab's `state.data.folder` in
`desktop.db`, containing expanded directories, filter, ignored-file preference,
selection and preview line selection. It contains no owner root or file contents.

The `folder` kind in `guest_recovery` retains at most 32 pending folder operations,
each limited to 32 KiB. It records the guest target, source version, exact host
operation request, original upload path and device/inode identity, and the last
observed host outcome. The original file remains on its filesystem. This budget
is separate from form input and artifact operations; either pending operation
blocks further writes to its guest. Input is saved before dispatch and survives
restart. Reconnection does not resend it. A changed or missing original file must
be selected again. Explicit status and fresh listings precede clearing recovery;
an unknown outcome requires inspecting the destination and an explicit decision.
Receiver execution and recovery release share a per-tab exclusion through
execution cleanup or release's status/list/delete sequence. Active requests cannot
lose their recovery record through release. The desktop release IPC names the
exact operation and, for an uncertain outcome, the outcome the person inspected.
If fresh status becomes uncertain or changes from that acknowledgement, recovery
remains until a new explicit inspection decision. Execution activity is transient
and is not stored in the recovery document.

The additive `guest_folder_routes` table records owner routing bindings for at
most 4096 operations during the host's 48-hour retention window. A binding fixes
the authenticated caller, source target, command and original local or remote
FolderIdentity before execution. It contains no credentials or file bytes and
is not an operation receipt. Status requires current peer authorization and
queries that original host even when the source tab has been trashed. Missing
bindings return unknown without executing anything. Existing database schema
versions and artifact/form recovery formats remain unchanged.

Plan guests keep view choice, selected work item, retained basis, current overview
scroll, work-item scroll and selected-basis scroll under `state.data.plan` in the
receiver's guest tab document. The optional `basisScrollY` reading field also
applies to local plan tabs. It defaults to zero. Existing guest and local records
remain readable; older builds can discard this new preference on save. No schema
version changes, owner plan bytes or authoritative plan copies are added to the
receiver. Owner updates preserve compatible reading fields.

Authenticated guest pending reads return the existing receiver operation input,
identity, dispatch marker and last outcome. They do not dispatch, settle or delete
the operation. CLI status settles the same identity; explicit reconciliation reads
status and current source before releasing the dependent-write block. A lost reply
never authorizes another preparation or execution with a new identity.
