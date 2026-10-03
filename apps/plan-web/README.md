# Collaborative HTML plans

This standalone web app belongs to the permanent exploration branch in
[HANDOFF.md](../../HANDOFF.md). Never merge that branch into main.

From the repository root:

```sh
vp install
vp run plan-web#build
vp run plan-web
```

Open `http://127.0.0.1:43130/plans/team-plan`. Visiting a new plan URL creates
it. Change the name in the URL to start another plan. The app accepts ordinary
HTML, including scripts. V1 has no authentication or authorization.

The browser is a reader and discussion tool. Agents edit HTML through the API.
The accepted HTML fills the content area and runs authored scripts. Comments
opens a panel; closing it gives the space back to the HTML. More contains
read-only history, exports, rejected comments and the browser HTML archive.
Returning from history shows the current accepted plan.

The User menu offers Alex, Blair and Casey with stable fake user IDs. Each tab
remembers its own choice through reload. Switching changes future comments and
presence; queued commands keep their captured author. Separate tabs keep
independent session identities, including tabs using the same fake user.
API agents supply their own actor.

Use Comment on preview, then click an element or position. A unique existing
authored HTML ID connects the comment. Missing IDs, duplicate IDs, generated
elements and ambiguous source matches produce detached comments. Selection,
cancellation and submission never insert IDs or change canonical HTML bytes.
Removing an element keeps its discussion; restoring its unique authored ID
reconnects it. History includes immutable HTML, comments, replies, resolution
state and the corresponding Git diff.

Comments, replies and resolution changes commit to the browser database before
the composer clears. Other tabs can deliver saved commands after their owner
closes. Network errors, timeouts and server errors retry the exact original ID
and payload. A permanent HTTP 400, 413 or 422 refusal parks the command without
blocking other comments. Rejected comments retains the original reason and
payload across reloads and offers edited retry, export and dismissal.

On the first database opening with this reader, a transaction freezes all old
browser HTML drafts and HTML outbox records into a read-only archive before
snapshot acceptance. It preserves HTML and base HTML bytes, actors,
generations, conflicts, request IDs, original status and rejection details.
HTML requests leave the live queue in that same transaction and never retry or
autoqueue. Pending records may already have reached the server, so their
original outcome remains unknown. Old draft rows also remain unchanged.
Export the archive for deliberate recovery by an agent. There are no browser
HTML editing, merging, saving or restoration controls. Archived HTML cannot
block comments or replace the accepted server HTML in the preview.

SQLite initialization retries competing writers asynchronously for up to five
seconds before reporting a timeout. The server requires native Git. It persists accepted state, events, snapshots,
and immutable command receipts in SQLite with WAL and full synchronous writes.
`PLAN_WEB_DB` selects its database file. `PORT` defaults to `43130`; `HOST`
defaults to `127.0.0.1`. Source development runs from this package, so its default
`./plan-web.sqlite` lives here. Keep the database, WAL and SHM files together.

The browser uses PGlite in a SharedWorker with IndexedDB and
`relaxedDurability: false`. Complete database operations run inside the worker.
A local transaction stores the accepted snapshot and replay cursor and retires
acknowledged comments together. Comment readiness belongs to a separate reader
row, independently of archived HTML. Durable comments need HTTPS or localhost,
SharedWorker and Web Locks support. Until storage is ready, cached or fetched
HTML remains readable while comment controls stay unavailable. Browser eviction
or clearing can remove unsent comments and archived work. Export HTML saves the
accepted HTML currently being viewed, including a selected historical version.

Agents use `/api/plans/:name`. GET returns the latest snapshot. POST
`/commands` accepts the command union in [contracts.ts](src/contracts.ts).
HTML edits carry `baseHtmlRevision`; every command carries an actor and stable
`requestId`. JSON command bodies are limited to 2 MiB. After an uncertain
outcome, retry exactly the same command and ID.
A changed payload under that ID rejects. A 409 preserves the original conflict
receipt; read current state and reconcile under a new ID.

GET `/events?after=N` on a plan emits typed `plan` events with revision IDs and transient
`presence` events without durable IDs. SSE resumes from its cursor or
`Last-Event-ID`; SQLite polling closes the snapshot/live gap and sees commits
from another server connection. Replay uses bounded batches, and a stalled
subscriber disconnects after five seconds so it can reconnect and catch up.
GET `/versions` pages history; GET `/versions/:revision` reads an exact snapshot.
POST `/presence` sends the session actor and pointer position.

The browser shares one origin-wide `/api/events?subscriptions=...` connection
inside the database worker. Subscriptions contain plan names and committed
revision cursors. Plan frames identify their plan through the snapshot; presence
frames contain `{name, people}`. Versioned SSE IDs encode the cursor map. The
endpoint accepts at most 20 plans, a 4,096-character encoded query and an
8,192-character combined query/cursor budget. The worker commits snapshots and
cursors before notifying tabs and reconnects from those committed cursors.
This avoids the browser HTTP/1 limit of six SSE connections per origin.

HTML and comments have a shared document revision. HTML also has a separate
revision, so comment traffic does not create false source conflicts. Presence
expires after 15 seconds and belongs to one server process. Durable writes and
replay safely share SQLite across server processes; presence does not.

Run API and browser scenarios with:

```sh
vp run plan-web:ready
vp test run --project=standard tests/plan-web-browser.test.ts --maxWorkers=1
```

The browser tests launch real Chromium against an isolated SQLite server. They
exercise comment readers and external API agents, independent tabs, duplicate
commands, restart, offline reload, lost and delayed acknowledgements, owner
closure, comment rejection recovery, authored DOM identity without HTML
mutation, physical database worker termination, eight tabs, eight separate plans,
read-only startup and preservation of legacy HTML records across database reopen.
Failure evidence is saved under `/tmp/scope-web-*-evidence.json` with screenshots
and observed command traffic.

## Remote cursors

Presence is transient and process-local, with a 15-second lease. Pointer updates bypass PGlite and durable command transactions. Each tab sends at most 30 updates per second, with two requests in flight and one coalesced latest position. A 500 ms timeout and a bounded retry deliver the last point even after movement stops. Presence traffic does not acknowledge a durable comment or HTML change.

The optional `sequence` field is a nonnegative safe integer. The browser keeps its per-session high-water value in sessionStorage across reloads. The server ignores lower or repeated sequence numbers. An old client without sequence numbers can use a fresh session, but cannot overwrite a sequenced session until its lease expires. Sequence values are transport ordering, not persisted plan revisions or wall-clock timestamps.

Presence writes wake subscribed event streams immediately, while retaining replay fairness and stalled-reader limits. Receiving browsers update keyed cursor elements on animation frames instead of removing and recreating them on each message. Actor lists update only when membership or identity changes. Comment pin updates remain separate from pointer-only updates.

Anchored positions are normalized to their element's bounds. Unanchored positions use document coordinates so viewers with different scroll offsets see the same point. Negative unanchored coordinates mean the pointer left the plan. History views, missing anchors and points outside the receiving viewport hide cursors. Stationary anchored cursors update after a viewer scrolls or resizes.

Focused Chromium tests exercise two independent browser contexts, injected request jitter, six concurrent agents, reordered packets, reloads, identity switches, stable DOM elements, geometry and eight same-origin tabs sharing one event connection. They measure capture to visible remote position, update cadence and final stopped-point arrival. Actual network links and Safari, Firefox and mobile backgrounding need separate validation.

## Agent CLI and MCP

Build the app-owned CLI with `vp run plan-web#build`, or build only the server
and CLI bundle with `vp run plan-web#cli:build`. The build writes
`apps/plan-web/dist/plan-web-cli-0.1.0.tgz`. The tarball bundles its runtime
JavaScript dependencies and requires Node 26.10 or newer. It is a local package;
this exploration does not publish it to npm.

Install the tarball into an agent's project with Vite+, then approve the agent
in your browser:

```sh
vp install /absolute/path/to/apps/plan-web/dist/plan-web-cli-0.1.0.tgz
vp exec plan-web login --server http://127.0.0.1:43130 --agent 'My coding agent'
vp exec plan-web whoami --server http://127.0.0.1:43130
vp exec plan-web mcp-config --server http://127.0.0.1:43130
```

Login displays an approval code and opens a browser. For a remote terminal, add
`--no-browser` and open the displayed URL on your own computer. Compare the
code, agent name and MCP endpoint before selecting Alex, Blair or Casey and
clicking Approve agent. Deny and Cancel refuse the grant. Ctrl+C cancels a
pending CLI login. These are development identities, with no external accounts
or Cloudflare credentials. The install, login, remote approval and whoami flow
follows the [Cloudflare CLI example](https://developers.cloudflare.com/cf/get-started/).

Paste the JSON from `mcp-config` into an MCP client's server configuration.
The installed CLI runs `mcp` over stdio and forwards tool requests to `/mcp`.
The bridge supports clients using the 2025 initialization handshake and modern
clients. The remote endpoint implements only the
[2026-07-28 Streamable HTTP protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
Each HTTP POST includes its protocol version, client metadata and mirrored
method/tool-name headers. HTTP does not use initialize, a session ID, GET event
streams or shared transport instances. The maintained TypeScript SDK creates a
fresh server for each HTTP request. The app pins `@modelcontextprotocol/server`
2.3.0 and the Node adapter 2.1.1. The browser's plan event stream remains a
separate REST connection.

Generic modern HTTP MCP clients can connect directly to the public `/mcp`
endpoint. A 401 supplies protected-resource discovery; authorization-server
metadata advertises public-client registration and authorization code with
S256 PKCE. Register exact HTTPS or loopback HTTP redirect URIs, use the endpoint
as the OAuth resource at authorization and token exchange, and validate the
returned issuer and state. Approval chooses the same three development
identities. This implements the public-client flow from the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
Client ID metadata documents, confidential clients, refresh tokens and other
grant types are not supported. Clients requiring those features must use the
stdio bridge. The CLI's polling endpoints are app-owned pairing; they do not
claim to implement the OAuth device authorization extension.

The tools read current plans, immutable revisions, paginated history and Git
diffs, apply HTML, add comments, reply, and resolve or reopen discussions. The
server injects the approved development user and agent name into every command.
Mutations require a caller-supplied stable `requestId`; keep it and the payload
after a timeout or lost reply. Read current content before applying HTML, and
send its `htmlRevision` as `baseHtmlRevision`. Conflicts preserve the original
receipt. Reconcile under a new request ID.

```sh
vp exec plan-web tools --server http://127.0.0.1:43130
vp exec plan-web call plan_read --json '{"name":"team-plan"}'
vp exec plan-web call plan_apply_html --json @command.json
vp exec plan-web logout --server http://127.0.0.1:43130
```

MCP approval grants read and write access to every plan on that endpoint.
Access tokens expire after eight hours; login again after expiry. Logout revokes
the saved credential on the server before removing it locally. The server
stores only credential and redemption-secret hashes in its app-owned SQLite
authorization tables. Pending grants expire after ten minutes, retain their
terminal state for at most another ten minutes, and redeem once. Pairing polling
starts at two seconds and slows repeated early polls. Authorization storage
allows at most 1,000 grants, 1,000 live credentials and 100 registered OAuth
clients. Grant and credential limits prune expired rows before new issuance;
registered clients persist across restarts.

CLI credentials live in a private SQLite file under
`~/.config/plan-web/credentials.sqlite`, outside the repository. The directory
uses mode 0700 and the file uses 0600. `PLAN_WEB_CLI_HOME` selects a different
private directory. Bearer tokens travel in headers and are absent from CLI
output and URLs. A lost token-issuance reply requires a new login, because a
grant cannot redeem twice.

For a reverse proxy, set `PLAN_WEB_ORIGIN` to its exact HTTPS origin before
starting the server. OAuth issuer, resource audience, Host and browser Origin
checks use that configured origin. Keep the proxy's Host header consistent.
Changing the endpoint invalidates credentials bound to the old endpoint.
Loopback HTTP works for local development; remote CLI endpoints require HTTPS.

MCP authentication protects MCP tool calls and the credential inspection route.
The v1 browser, plan REST reads, commands and presence remain open. Fake identity
approval does not authenticate a real person or provide application-wide access
control.
