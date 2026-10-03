# Collaborative plan web exploration

This package belongs only to the permanent exploration branch described in
`../../HANDOFF.md`. Never merge that branch into `main`.

The backend owns accepted plan state, immutable revisions, command receipts,
and replayable events in SQLite. The browser owns its recovery database in
PGlite with IndexedDB and an app-owned SharedWorker. Complete local database
operations run inside that worker. The worker owns one multiplexed event stream
for all subscribed plans and resumes from committed cursors. Use
`relaxedDurability: false`. Never acknowledge a
queued comment as durable until browser persistence succeeds. Never advance a
replay cursor without storing the corresponding snapshot in the same local
transaction. Retire only acknowledged comment requests. Freeze legacy HTML records before any accepted snapshot can change them; never send archived HTML.

Keep web app contracts in `src/contracts.ts`, shared by its browser and server.
Do not import desktop internals or change existing artifact contracts.
Presence is transient. HTML and comment changes are versioned. Scripts run in
authored HTML; do not serialize their runtime DOM into canonical HTML source.
