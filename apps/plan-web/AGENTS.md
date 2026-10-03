# Collaborative plan web exploration

This package belongs only to the permanent exploration branch described in
`../../HANDOFF.md`. Never merge that branch into `main`.

The backend owns accepted plan state, immutable revisions, command receipts,
and replayable events in SQLite. The browser owns its recovery database in
PGlite with IndexedDB and the official multi-tab worker. Never acknowledge a
queued edit as durable until browser persistence succeeds. Never advance a
replay cursor without storing the corresponding snapshot in the same local
transaction. Preserve newer draft generations when retiring commands.

Keep web app contracts in `src/contracts.ts`, shared by its browser and server.
Do not import desktop internals or change existing artifact contracts.
Presence is transient. HTML and comment changes are versioned. Scripts run in
authored HTML; do not serialize their runtime DOM into canonical HTML source.
