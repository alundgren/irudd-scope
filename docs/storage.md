# Storage and recovery

Electron main owns Scope's persistent data. Defaults below apply on macOS.
Use the [development environment variables](development.md#isolated-development)
to select separate directories for development.

| Data                | Location                                                       | Contents                                                                 |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Artifact library    | `~/Library/Application Support/irudd-scope/artifacts/scope.db` | Published metadata and binary content.                                   |
| Desktop preferences | `~/Library/Application Support/irudd-scope/desktop.db`         | Appearance, provider settings, open and closed tabs, and diagram drafts. |
| Provider API key    | macOS Keychain                                                 | One credential entry per desktop profile.                                |
| CLI discovery       | `~/.config/irudd-scope/desktop.json`                           | Versioned loopback endpoint and publishing token, mode `0600`.           |

Scope creates database directories with mode `0700` and database files with
mode `0600`. Treat the whole profile and discovery file as private. Explicit
imports and downloads use files; ordinary storage uses SQLite.

Closing a tab retains its artifact and diagram draft. A draft contains the
working canvas, base revision, conversation, unsent prompt, panel state, and
zoom and pan. Save publishes the canvas as an artifact revision. Draft writes
are coalesced during editing and flushed before closing a tab or window.
Failed writes keep the working canvas available with a retry action.

## Backup and restore

Quit Scope before copying `scope.db` and `desktop.db`, or use SQLite's online
backup API for each database. Copying only a database file while Scope runs
can omit committed data in its WAL file. Restore both databases with Scope
closed. Provider keys stay in Keychain and are not part of these backups.

The discovery file is needed by local publishers. Keep a private copy if you
need to preserve the publishing token. Deleting it with Scope closed causes
the next launch to generate a new token; remote callers must then use that
token. The library and preferences remain intact.

## Supported data imports

Scope reads artifact schema version 2 and desktop schema version 4. It rejects
newer schema versions. Back up the complete data directories before an upgrade
when you need the option to return to an older desktop.

For an artifact directory containing a database and a `blobs/` directory,
Scope verifies hashes, sizes, and referenced content before importing bytes
into SQLite in one transaction. It removes verified content files after
commit. Missing or corrupt content stops migration and retains the database
and files. To move such a library, stop every process using it, copy the
complete directory, and set `SCOPE_DATA_DIR` to the copy. Do not merge it with
a nonempty library or run two stores against it.

Settings JSON versions 1 and 2 import into `desktop.db`. Encrypted provider
keys require macOS secure storage and migrate directly to Keychain. The JSON
file is removed only after the replacement is saved. A failed credential
import retains it for retry. Obsolete connection settings are discarded.
Saved browser tab preferences import once into SQLite and are then removed
from browser storage. Existing artifact-ID tab lists migrate to workspace
version 2 with stable tab and group UUIDs. Open order, selection, closed tabs,
and artifact-keyed diagram drafts are retained. File references acquire their
registered viewer type when the library loads. Groups and versioned plugin
state live in the saved workspace document. Unknown plugin types retain their
records and display an unavailable view.

These import paths support existing data. New writes use the stores listed
above. Restore the complete backup before using a desktop that cannot read
the upgraded schema.
