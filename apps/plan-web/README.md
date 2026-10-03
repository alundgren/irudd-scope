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
HTML, including scripts. The v1 browser and plan REST API remain open. MCP tools
require an agent credential approved in the browser.

People edit HTML source beside a live preview. Edits first commit to the
browser recovery database and then send to the server. Disjoint source changes
reconcile across multiple separate text changes; overlapping changes preserve
the draft and open a merge editor. Browser merging uses bounded
[jsdiff character changes](https://github.com/kpdecker/jsdiff). Each changed-region
search allows 100 ms and 10,000 insertions/deletions; exceeding either budget
preserves the draft for manual reconciliation. Pure insertions/deletions avoid
that search. A whole-source paste replaces the visible source, including any
older content it deliberately reintroduces; that change receives its own version.
The top-bar User menu offers Alex, Blair and Casey with stable fake user IDs.
Each tab selects its user independently and remembers that choice for tab
reloads. Switching changes future edits and presence; already queued commands
keep their original author. API agents still supply their own actor.
Each tab owns an independent editor identity. Other tabs can deliver its saved
commands after it closes. Saved browser drafts also exposes unresolved work.
Permanent HTTP 400, 413 or 422 rejection parks the immutable command without
blocking other editors. Rejected changes retains its reason and original payload
across reloads, with export and dismissal. Rejected HTML stays editable; a changed
draft sends under a new ID. Restore rejected HTML lets another tab recover it
for editing, without automatically resending it. Both saved browser drafts and
rejected HTML keep source and merge inputs read-only during restoration so typing
cannot race the recovered generation. Recovery retries reuse the same durable
operation ID rather than replacing the draft again. An
uncertain local restore keeps editing locked until Retry local save confirms
the durable row; HTML export remains available. Rejected comments offer an
editable retry. Network errors, timeouts and server errors keep the original ID.

Use Comment on preview to choose an element or position. Authored elements
receive persistent HTML IDs when needed. Generated or ambiguous elements stay
detached. Removing an element keeps its discussion; restoring its unique ID
reconnects it. History shows immutable HTML, comments, replies, resolution
state and the corresponding Git diff.

SQLite initialization retries competing writers asynchronously for up to five
seconds before reporting a timeout. The server requires native Git. It persists accepted state, events, snapshots,
and immutable command receipts in SQLite with WAL and full synchronous writes.
`PLAN_WEB_DB` selects its database file. `PORT` defaults to `43130`; `HOST`
defaults to `127.0.0.1`. Source development runs from this package, so its default
`./plan-web.sqlite` lives here. Keep the database, WAL and SHM files together.

The browser uses PGlite in a SharedWorker with IndexedDB and
`relaxedDurability: false`. Complete database operations run inside the worker.
A local transaction stores the accepted snapshot and replay cursor, retires
acknowledged commands and preserves newer draft generations together. Browser
editing needs HTTPS or localhost, SharedWorker and Web Locks support. Browser
eviction or clearing can remove unsent drafts. Export HTML saves the live local
draft, including while viewing history.

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
PLAN_WEB_PRESSURE_ROUNDS=50 vp test run --project=standard tests/plan-web-browser.test.ts -t 'multiple humans' --maxWorkers=1
```

The browser tests launch real Chromium against an isolated SQLite server. They
exercise humans and agents, independent tabs, duplicates, restart, offline
reload, uncertain responses, copied tab identities, successor drafts, conflict
recovery, comments, authored DOM identity, physical database worker termination,
permanent rejection recovery, eight tabs, eight separate plans and read-only startup before local recovery is ready. Failure evidence is saved under
`/tmp/scope-web-*-evidence.json` with screenshots and observed command traffic.

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
