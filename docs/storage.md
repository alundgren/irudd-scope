# Storage and recovery

Electron main owns Scope's persistent data. Defaults below apply on macOS.
Use the [development environment variables](development.md#isolated-development)
to select separate directories for development.

| Data                | Location                                                       | Contents                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact library    | `~/Library/Application Support/irudd-scope/artifacts/scope.db` | Active, queued, and trashed tabs, retention timestamps, published metadata, content references, bytes, and diagram drafts.                                                   |
| Desktop preferences | `~/Library/Application Support/irudd-scope/desktop.db`         | Appearance, provider settings, workspace groups and selection, remote configuration, and retained speech receipts/audio.                                                     |
| Provider API key    | macOS Keychain                                                 | One credential entry per desktop profile.                                                                                                                                    |
| Remote credentials  | macOS Keychain                                                 | Connection tokens keyed by hub ID, in the desktop profile's credential entry.                                                                                                |
| CLI discovery       | `~/.config/irudd-scope/desktop.json`                           | Versioned loopback endpoint and publishing token, mode `0600`.                                                                                                               |
| Hub settings        | `~/.local/share/irudd-scope/hub/hub.db` on the remote          | Hub identity, listener configuration, credential hashes, pairing expiry, remote update status, buffered publication bytes/metadata, and recently observed artifact metadata. |

Scope creates database directories with mode `0700` and database files with
mode `0600`. Treat the whole profile and discovery file as private. Explicit
imports and downloads use files; ordinary storage uses SQLite.

Certificate-signed Mac installations access the existing Keychain entry through
the bundled **Scope Credentials** helper. The service name, profile account,
and credential JSON remain compatible with direct Keychain access. Approving
the helper changes access permission, not the stored provider key or remote
tokens. Changing the executable that accesses this entry may require another
Keychain approval.

Closing an individual tab moves it to Trashcan and retains its content and state. A draft
contains the working canvas, base revision, conversation, unsent prompt, panel
state, and zoom and pan. Autosave writes the draft before updating the artifact
revision. Conversation and viewport changes update only the draft. If a newer
artifact arrives before pending canvas edits are published, the draft retains
those edits until the user chooses which version to keep.
An unviewed diagram draft can omit its viewport so Scope fits it when first
displayed. Existing drafts with a viewport retain their saved zoom and pan.
Quitting Scope, closing its last window, updating, and restarting preserve tabs
that remain open. Pending edits flush before application shutdown.

Every publication commits a queued tab before accepting content or metadata.
Tab-owned records reference that tab in `scope.db`. Tabs store a permanence
flag, last-visible timestamp, and nullable trash timestamp. The trash timestamp
takes precedence over permanence. Restoring clears it, keeps the previous
permanence, and resets visibility time. Late workspace saves cannot clear trash
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
enough. Startup, Mac resume, and one-minute checks re-evaluate eligibility.
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
works with the Mac disconnected. A stateless forwarding hub has no database.

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

Remote records share `desktop.db` with other preferences. Their tokens never
enter SQLite. Removing a remote revokes the credential on the hub before
removing the Mac's saved record and Keychain token. If the hub is unavailable,
the record stays disconnected so removal can be retried. Linux desktop
development keeps connection tokens in memory; after restart, re-pair using
`irudd-scope hub unpair` and `irudd-scope pair` on the remote.

The hub uses the same private discovery format as local desktop publishing,
with its own publishing token. Do not share one discovery file between a hub
and a desktop on the same host. Set `SCOPE_CONNECTION_FILE` to separate paths.
Hub state includes undelivered publication bytes and metadata. Back up its
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
a different Mac pairing. Installation builds and skill files
contain program code and live separately from this state.

Remote build metadata records its commit and installation paths alongside the
bundled code. The hub's SQLite update record retains the target commit, phase,
and failure message across restarts. Updating the remote tools does not replace
its database or discovery file. The updater retains the previous build for
startup recovery. This restores program files, not the hub database.

Quit Scope before copying `scope.db` and `desktop.db`, or use SQLite's online
backup API for each database. Copying only a database file while Scope runs
can omit committed data in its WAL file. Restore both databases with Scope
closed. Provider keys stay in Keychain and are not part of these backups.

The discovery file is needed by local publishers. Keep a private copy if you
need to preserve the publishing token. Deleting it with Scope closed causes
the next launch to generate a new token; remote callers must then use that
token. The library and preferences remain intact.

## Supported data imports

Scope reads artifact schema version 6, desktop schema version 7, and hub schema
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
builds reject schema 5; restore a pre-upgrade backup to downgrade. Diagram drafts may
also contain an editable proposal and the selected conversation recipient.
Drafts without a viewport require a desktop that supports fitting on first
display; older desktops cannot open those drafts.
Permanent deletion removes these with its ordinary content. Delta history is bounded
in renderer memory and disappears on restart. The hub stores no diagram model.

An agent's explicit `diagram pull --output FILE` export is a disposable working
file in its worktree. It contains a base, current native document, and optimistic
version; image data is stored once, with hashes in the base. Removing the worktree
removes these files. Another session can pull the same name to a new file while
the Scope tab exists. There is no global agent cache to collect.

For an artifact directory containing a database and a `blobs/` directory,
Scope verifies hashes, sizes, and referenced content before importing bytes
into SQLite in one transaction. It removes verified content files after
commit. Missing or corrupt content stops migration and retains the database
and files. To move such a library, stop every process using it, copy the
complete directory, and set `SCOPE_DATA_DIR` to the copy. Do not merge it with
a nonempty library or run two stores against it.

Settings JSON versions 1 and 2 import into `desktop.db`. Diagram generation
defaults to off when its preference is absent. Existing Keychain keys are
retained. Encrypted provider keys in legacy JSON require macOS secure storage
and migrate directly to Keychain on the first shared-key operation.
Startup imports ordinary preferences without accessing credentials. The legacy
JSON remains until its key has migrated, including across restarts and failed
access attempts. It is removed only after the replacement is saved. Obsolete
connection settings are discarded.
Existing artifact-ID tab lists first acquire stable tab and group UUIDs in
`desktop.db`. On startup, Scope imports saved open tabs and their drafts into
`scope.db`, then removes the old workspace document and artifact-keyed drafts
from `desktop.db`. Workspace views use version 3. Order, selection, groups,
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

## Speech requests

The desktop-main `voice/` module owns `voice_requests` in `desktop.db`. Each row
contains a caller request ID, a versioned SHA-256 of normalized narration and speech settings,
expiration time, validated JSON receipt, and optional WAV bytes. Narration itself
is not retained. The receipt retains OpenRouter's generation ID when returned.
Credentials remain in Keychain on macOS and process memory on Linux.

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

## Plan history and feedback

HTML plans use the existing `scope.db` tab ownership and blob tables. Plan
revision rows retain HTML blobs; plan image rows retain original and marked
PNGs. Comments, submitted rounds, responses, approval timestamps, idempotency
receipts and unfinished screenshot drafts belong to the same tab. Closing it
preserves those records in Trashcan. Permanent deletion or trash expiry cascades
through their references; normal blob reclamation then removes unused bytes.
Repeated identical images and HTML share their SHA-256 blob. Revisions and
feedback have no separate expiry while the tab exists.

The plan migration is additive and preserves existing artifacts and workspace
records. Older Scope builds reject the newer database version; do not open the
profile with an older build. Back up the complete databases using the existing
backup procedure. Explicit `plan feedback`, `plan content` and `plan image`
exports are local files, independent of Scope's SQLite records, and refuse to
overwrite existing output paths.
