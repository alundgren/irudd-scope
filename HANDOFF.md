# Collaborative plan web exploration

Permanent branch: `t3code/collaborative-plan-web-exploration`.
**Never merge this branch into `main` or any release branch. Never create a PR from it to main.** Implementation PRs target this branch and merge here after independent review and app-only validation.

## Product and workflow

This is a standalone web app in `apps/plan-web`. A plan is ordinary authored HTML with a name and URL. Visiting an unknown plan creates it. Humans read and comment; agents edit through REST or MCP. Each browser tab selects Alex, Blair or Casey independently. Comments attach to unique authored IDs, detach when those IDs disappear and reconnect when restored. Runtime-only and duplicate IDs remain detached. Comment placement never edits HTML.

The app is independent of Scope. Do not run Scope builds or tests, including repository `ready`, recursive builds, Electron, Xvfb or Scope CLI builds. Use Vite+ and the app-only commands below. Keep implementers in isolated worktrees with child PRs against this permanent branch. Independently review frozen heads before integrating, then test the combined app. The explicit user override takes precedence over the repository-wide validation gate.

## Start and validate

```sh
vp install --frozen-lockfile
vp run plan-web#build
vp run plan-web
# Only this app's build, formatting, types and tests:
flock /tmp/plan-web-browser-validation.lock vp run plan-web:ready
```

Open `http://127.0.0.1:43130/plans/team-plan`. The app build also creates its CLI tarball. The shared lock avoids concurrent browser suites and CPU-heavy benchmarks corrupting cursor measurements. No credentials or production data are needed for tests.

## Current behavior

The browser is a full-width reader with a compact header. Comments toggle into a side panel. History, export, rejected comments and archived old HTML records are under More. Humans cannot edit or restore HTML in the browser. Agent API edits appear live. Old browser HTML drafts and outgoing HTML requests are frozen in a read-only archive with their original actor, revision, generations and IDs; they are never automatically resent. Export the archive for deliberate agent recovery.

The server owns accepted HTML, comments, immutable revisions, Git-generated display diffs, receipts and replayable events in SQLite. WAL, full synchronous writes and one `BEGIN IMMEDIATE` transaction commit state, event and receipt together. The existing durable stream is already authoritative; Git is not the primary database. Disjoint HTML replacements rebase; overlapping replacements return an immutable conflict receipt. Agents reconcile under a new request ID. REST and presence remain open for v1.

The app-owned SharedWorker owns PGlite in IndexedDB with `relaxedDurability: false`, serializes complete local transactions and holds a Web Lock. It persists comment requests before acknowledging them and commits snapshot/cursor changes atomically. Another tab can deliver a closed tab's queued comments. One multiplexed SSE connection covers all plans on the origin. Reconnect uses committed cursors; replay and stalled readers are bounded. Browser storage is origin-local and may be cleared or evicted. HTTPS or localhost and SharedWorker/Web Locks are required for durable commenting.

Presence remains process-local and expires after 15 seconds. Pointer capture is immediate; each tab sends approximately 30 updates per second, with at most two requests in flight and one latest pending point. Monotonic sequence numbers reject reordered positions. Sequence high-water values survive tab reload in sessionStorage. Server presence changes wake the stream immediately. Receiving browsers keep cursor DOM nodes and update positions on animation frames. Leaving the plan, viewing history or losing an authored anchor hides the affected cursor.

## Agent connection

```sh
vp install /absolute/path/to/apps/plan-web/dist/plan-web-cli-0.1.0.tgz
vp exec plan-web login --server http://127.0.0.1:43130 --agent 'Planning agent'
vp exec plan-web whoami --server http://127.0.0.1:43130
vp exec plan-web mcp-config --server http://127.0.0.1:43130
```

Login opens a browser approval page. Choose Alex, Blair or Casey after comparing the displayed code, agent name and endpoint. `--no-browser` supports a remote terminal. These are development identities; no real provider is configured. Paste `mcp-config` output into the agent client. The CLI stdio bridge supports older MCP clients; `/mcp` uses the 2026-07-28 stateless HTTP protocol and creates a fresh SDK server for each request.

Direct modern HTTP clients can use OAuth discovery, public-client registration and S256 PKCE. MCP tools read plans, versions, history and diffs, apply HTML, add comments, reply and resolve discussions. Mutations require a stable caller-supplied `requestId`. The server derives actor identity from the approved credential. Grants and credentials are durable; approval redeems once, access expires after eight hours and logout revokes it. CLI credentials live outside the repository in a private SQLite file. This protects MCP, not the intentionally open browser and REST API. See [the app guide](apps/plan-web/README.md) for supported OAuth features and limits.

## Preview is stopped

The user requested shutdown. `collaborative-plan-web-preview.service` is disabled and inactive, port 43130 has no listener and only the Tailscale Serve route on HTTPS port 8455 was removed. Other host routes remain. The old tailnet URL is unavailable while stopped.

The retained user unit is at `~/.config/systemd/user/collaborative-plan-web-preview.service` on cloudbox. It runs this checkout's compiled `apps/plan-web/dist/server/server-main.mjs` with the existing SQLite database. For a later explicitly requested preview, configure `PLAN_WEB_ORIGIN=https://cloudbox.tail5db861.ts.net:8455`, rebuild the app, start the unit and restore only that route:

```sh
vp run plan-web#build
systemctl --user start collaborative-plan-web-preview.service
sudo tailscale serve --bg --https=8455 http://127.0.0.1:43130
```

Preserve the HTTPS Host header. The configured origin controls issuer, approval URLs and credential audience. Do not enable automatic startup unless requested. The browser has separate recovery storage on localhost and the HTTPS origin.

## Semantic history experiment

[The isolated experiment](apps/plan-web/experiments/semantic-history/README.md) keeps canonical HTML while recording stable-ID operations, actor intent, explicit conflicts, immutable receipts, logical branches, merge ancestry, restore and checkpoints. It has no production routes or migration. The three-agent case retains independent deployment context and both competing SQLite/DynamoDB choices; resolution appends history.

A local synthetic 27.8 KB document with 1,000 changes used 88.3 MB of SQLite in the current store and 2.4 MB in the candidate. Median writes were 15.9 ms current and 75.6 ms candidate. Candidate checkpoint read was 40.3 ms; full replay was 2.61 s. Block replacements also conflict on independent words the current text merger can retain. These results support an optional stable-ID operation API with intent, not replacing the running store wholesale. Preserve arbitrary scripts, styles and authored markup. The supplied AST design is not implemented.

## Review and validation

The reader, MCP, cursor performance and isolated operation experiment were independently reviewed before merge through PRs [90](https://github.com/alundgren/irudd-scope/pull/90), [91](https://github.com/alundgren/irudd-scope/pull/91), [93](https://github.com/alundgren/irudd-scope/pull/93) and [92](https://github.com/alundgren/irudd-scope/pull/92). Exact final validation receipts follow the combined app gate. Earlier backend, stream and browser work is merged through PRs [82](https://github.com/alundgren/irudd-scope/pull/82), [83](https://github.com/alundgren/irudd-scope/pull/83) and [85](https://github.com/alundgren/irudd-scope/pull/85). The branch incorporates origin/main at `8f8d630`.

## Next work

1. Try the reader/comment/agent loop with two humans over the tailnet when preview is requested again. Check cursor behavior on real network links and actual team devices. Automated browser coverage is Chromium; Safari, Firefox and mobile background behavior remain unvalidated.
2. Add or reject a production stable-ID operation API using real agent edits. Decide how nested HTML, structural conflicts, reviewed merge heads, grouped intent and finer text edits should work before integrating the experiment. No reconciliation agent is wired up.
3. Measure PGlite download/startup, memory and comment enqueue cost against native IndexedDB. SQL convenience does not establish the best browser store. Storage eviction remains a limit.
4. Measure large-document Git diff blocking and retained history growth. Native Git runs synchronously on the server; do not replace it without measured need. Add backup/restore drills before this becomes a persistent team tool.
5. Package the CLI for distribution if wanted. The local tarball is tested; nothing has been published to npm. Real login, application-wide access control, confidential OAuth clients, refresh tokens and client metadata documents remain outside v1.
6. Multi-server presence, more than 20 subscribed plans and hosting beyond this exploratory process require additional work. Current durable commands/replay can share SQLite, while presence belongs to one process.
