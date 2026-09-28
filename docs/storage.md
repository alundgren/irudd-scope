# Storage and recovery

Electron main owns Scope's persistent data. Defaults below apply on macOS.
Use the [development environment variables](development.md#isolated-development)
to select separate directories for development.

| Data                | Location                                                       | Contents                                                                                             |
| ------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Artifact library    | `~/Library/Application Support/irudd-scope/artifacts/scope.db` | Open and queued tabs, published metadata, content references, bytes, and diagram drafts.             |
| Desktop preferences | `~/Library/Application Support/irudd-scope/desktop.db`         | Appearance, provider settings, workspace groups and selection, and remote configuration.             |
| Provider API key    | macOS Keychain                                                 | One credential entry per desktop profile.                                                            |
| Remote credentials  | macOS Keychain                                                 | Connection tokens keyed by hub ID, in the desktop profile's credential entry.                        |
| CLI discovery       | `~/.config/irudd-scope/desktop.json`                           | Versioned loopback endpoint and publishing token, mode `0600`.                                       |
| Hub settings        | `~/.local/share/irudd-scope/hub/hub.db` on the remote          | Hub identity, private endpoint, local listener configuration, credential hashes, and pairing expiry. |

Scope creates database directories with mode `0700` and database files with
mode `0600`. Treat the whole profile and discovery file as private. Explicit
imports and downloads use files; ordinary storage uses SQLite.

Certificate-signed Mac installations access the existing Keychain entry through
the bundled **Scope Credentials** helper. The service name, profile account,
and credential JSON remain compatible with direct Keychain access. Approving
the helper changes access permission, not the stored provider key or remote
tokens. Changing the executable that accesses this entry may require another
Keychain approval.

Closing an individual tab permanently deletes its content and state. A draft
contains the working canvas, base revision, conversation, unsent prompt, panel
state, and zoom and pan. Save publishes a revision; draft writes do not.
Quitting Scope, closing its last window, updating, and restarting preserve tabs
that remain open. Pending edits flush before application shutdown.

Every publication commits a queued tab before accepting content or metadata.
Tab-owned records reference that tab in `scope.db`. Closing deletes the tab,
metadata, content references, and drafts in one transaction. A crash before
commit leaves the whole tab intact; after commit the whole tab is gone.
Late workspace and draft saves cannot insert a missing tab. Shared bytes remain
while any tab references them. There is no deletion history or pending-deletion
log. Workspace selection and groups remain separate application preferences.

## Reclaiming disk space

Uploads and unsuccessful updates retain content references for fifteen minutes
after upload. This covers the gap before metadata publication, including content
shared with another tab that closes in the meantime. An abandoned publication's
queued tab expires after its staging references expire. Successful publications
that exceed the 100-open-tab limit stay queued in the library. Closing another
tab does not evict or delete them. Cleanup runs at startup, during shrink, and
at one-minute maintenance checks. A shrink receipt reports bytes still protected
by staging; it does not claim those bytes were reclaimed.

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
Hub state contains no artifact bytes. Back up its database and discovery file
together if you need to retain pairings. Installation builds and skill files
contain program code and live separately from this state.

Quit Scope before copying `scope.db` and `desktop.db`, or use SQLite's online
backup API for each database. Copying only a database file while Scope runs
can omit committed data in its WAL file. Restore both databases with Scope
closed. Provider keys stay in Keychain and are not part of these backups.

The discovery file is needed by local publishers. Keep a private copy if you
need to preserve the publishing token. Deleting it with Scope closed causes
the next launch to generate a new token; remote callers must then use that
token. The library and preferences remain intact.

## Supported data imports

Scope reads artifact schema version 3, desktop schema version 6, and hub schema
version 2. It rejects
newer schema versions. Back up the complete data directories before an upgrade
when you need the option to return to an older desktop.

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
and migrate directly to Keychain on the first enabled diagram key operation.
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
