# Architecture

Scope stores artifacts from coding agents and shows them to a human. Publishing must work while the Mac sleeps. AI generation runs only while the Mac and desktop app are open.

```text
Mac or VM                                        Ubuntu VM
Codex / Claude / human
        |
        | publish, update, list
        v
packages/cli ---- HTTPS over tailnet -----------> apps/hub
        |         or VM loopback                    |
        |                                           +--> SQLite metadata and artifact bytes
        |
        |                          artifact reads, writes, SSE
        |                                           |
        |                                           v
        |                                      apps/desktop
        |                                      Electron main
        |                                       /         \
        |                     validated IPC    /           \ model calls
        |                                     v             v
        |                              React renderers   OpenRouter
        |                                     |
        |                              sandboxed HTML
        |
        +---------------------> packages/protocol <--- hub / desktop
                                 shared contracts

Planned optional additions:
  Codex / Claude tool-size adapters -> hub event storage -> optional session tab
  Local Codex / Claude CLI provider -> desktop diagram generation
```

## Ownership

`packages/protocol` owns artifact types, input validation, wire formats, limits, and the shared HTTP client. It has no dependency on an application, filesystem, Electron, or a model provider. Its README defines the public commands and exchanges beside those contracts.

`apps/hub` owns durable artifact metadata, revisions, content, authentication, and live notifications. The hub listens on loopback. Tailscale Serve provides private HTTPS. One SQLite database contains artifact metadata and binary content. The hub never receives an OpenRouter API key.

`packages/cli` owns file detection, explicit publication, and cheap optional provenance from hostname, cwd, Git, and supplied agent/session information. It uses the protocol client. It does not inspect transcripts or launch agents.

`apps/desktop` owns the human workspace, rendering, local preferences, credentials, and model execution. Electron main owns network access and saved secrets. The sandboxed React renderer uses a small preload API. Artifact renderers use artifact data, not hub credentials. A renderer registry selects a component by artifact kind.

Dependencies point from each app and CLI to `packages/protocol`. No app imports another app's internal source. Desktop-only provider and renderer code stays in desktop until a second real consumer justifies moving it.

## Persistent data

The hub is authoritative for artifact content and metadata. An artifact has a stable ID and an increasing revision. Create refuses an existing ID. Update requires the expected revision, so two writers cannot silently overwrite one another. Closing a desktop tab only changes local workspace preferences.

The hub's `scope.db` stores metadata and a BLOB table keyed by SHA-256. Uploads insert complete content before metadata references it. A failed metadata write can leave an unused database row, but never an artifact pointing at unfinished content. Revision checks and metadata writes share a transaction. The first version keeps the current artifact revision without a history browser.

The Mac's `desktop.db` stores ordinary settings and open-tab preferences as readable data. Credentials live directly in macOS Keychain. Neither database stores credential plaintext or ciphertext. Linux development keeps credentials only in memory. Artifact content remains authoritative on the hub; the desktop's current content cache is in memory.

Both applications use `@effect/sql-sqlite-node` with an owned Effect runtime that closes the database on shutdown. It uses Node's synchronous SQLite driver, so database calls can still block the event loop. Uploads are bounded to 32 MiB and four concurrent requests. SQLite is the default for all new Scope persistence. Explicit user imports and downloads use files, and Electron still manages its own caches.

Hub schema version 2 imports the legacy blob directory, verifies content hashes and referenced sizes, and commits the new schema before removing imported files. A failed verification leaves the previous database version and source files intact. Desktop startup migrates ordinary JSON settings into SQLite and saved credentials into Keychain. The renderer transfers existing tab preferences once through validated IPC and then clears its legacy localStorage entry. Existing artifact IDs and revisions remain unchanged.

Optional provenance fields are absent when unknown. Missing information must not prevent publication. Session records and hook installation are not prerequisites for artifact records.

SSE announces changes. Clients reconcile the current artifact list on connection and reconnection. Stored artifacts survive a missed event, a closed app, and a hub restart. The stream is a notification channel, not the durable archive.

## Desktop security and providers

Agent HTML is untrusted. Preview it in a sandboxed iframe with no scripts, same-origin permission, forms, popups, parent access, or external network access. Do not load it as a privileged Electron page. Downloads use an explicit save dialog in main.

The preload API exposes named operations and validates IPC callers. It must not expose arbitrary filesystem access, shell execution, fetch, Electron objects, or secret-reading methods. The app blocks unexpected navigation, child windows, and permissions.

Settings initially offers OpenRouter and `google/gemini-3.8-flash`. The trusted settings form can submit a new key once. Main stores credentials directly in Keychain through `@napi-rs/keyring`, clears the submitted value from the form, and returns only saved status. One Keychain entry belongs to each desktop profile, under service `alundgren.irudd-scope`. Replacing and removing a key are supported. `safeStorage` is used only to decode legacy credentials during migration. Stable code signing and native Mac acceptance checks are required before release.

Linux development must not persist a key through Electron's insecure fallback. A key may be used in memory for that process. Standard tests use synthetic responses and never need a real key. Hub credentials are also kept out of artifact renderers.

Diagram generation accepts intent and a compact semantic scene and returns validated semantic drawing operations plus usage. `apps/desktop/src/diagram/contract.ts` owns `DiagramProvider`; `openrouter.ts` owns OpenRouter's wire format. The renderer translates validated operations into Excalidraw elements. Future local Codex and Claude CLI providers implement that same narrow task contract inside desktop main. They must not become a generic execution API. Provider choice is not part of the artifact transport.

The Create diagram tool and an existing diagram's change field invoke this provider. Generation is explicit, with one request at a time and a cancel action. The first slice does not accept remote generation jobs through the hub. Agents can publish a finished `.excalidraw` file immediately; a CLI command that delegates generation to the open Mac app is later work.

## Delivery boundaries

The current slice implements text/Markdown, image, static HTML, file, and Excalidraw publication through CLI, hub, and desktop, including stable updates, SSE, persistence, and settings. Editable Excalidraw and the explicit diagram tool reuse the semantic operations and canvas adapter from the drawing experiment. Optional provider-neutral observation of tool-call sizes and session analysis are planned. Retain raw provider details where normalization would lose information.

No MCP, agent orchestration, remote commands, accounts, public ingestion, collaboration server, transcript archive, or plugin system is needed for this slice. The visual design is deliberately left to the separate prototype brief; functional development can use a compact neutral UI.
