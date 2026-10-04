# Agent-initiated Scope retrospectives

Start this workflow when the person you are working with says "let's do a
Scope retro" in a normal coding session. Scope never starts coding agents.
Read `retro guide` from the installed CLI for its validated command schema and
load `session-retrospective/references/cross-session.md` for native collectors.
That skill owns the one native accounting parser; do not duplicate it in Scope.

## Select sources and repositories

Read Scope retrospective settings. One Scope Mac owns source names, SSH aliases,
runtime roots, inclusion choices, optional destinations and audited IDs. Ask
which local or saved SSH sources to include when they are not configured. Use
the external agent's own SSH access to inspect those hosts. Scope hub connection
addresses are not SSH aliases. No service is installed on a source.

Read every tracking page for each source/runtime. Obtain the current native
session ID from the runtime environment or confirmed native metadata. A T3
host thread ID is a delivery address, not automatically a native session ID.
Exclude the current agent ID,
all recorded retrospective-agent IDs and all audited native IDs before analysis.
Use the metadata inventory helper on each available source, then exhaust its
pages. Keep the first page's `discoveredAt` cutoff. A changed inventory requires
restarting discovery; incomplete discovery prevents staging initialization. Every
selected root must have readable native session directories; a missing or
unreadable selected root is never successful empty discovery.
The listing does not read conversation excerpts or tool results into the report.

For each source/runtime that has never been initialized, ask:

- No, start from now. Stage `from-now` at the metadata discovery cutoff.
- Check first. Show matching session count and oldest native start date from
  complete metadata discovery, then ask whether to review all or start from now.
- Yes, review all available history. Stage `all` and select matching sessions.

Initialization is pending until a finished retrospective. A from-now choice
uses the discovery cutoff, not the later finish timestamp. After initialization,
select unaudited whole native sessions according to Scope tracking and repository
inclusion choices. For `from-now`, require native `startedAt` strictly after the
saved discovery cutoff. Unknown start dates leave eligibility unavailable with
an explicit coverage note and no audited marker. An audited ID stays excluded even when resumed later. A new
native session is eligible. Do not implement message offsets or changed-session
requalification. A deliberate manual review can select an old ID separately.

Identify Git repositories from reliable native origin metadata or bounded Git
origin lookup in the recorded cwd. Preserve forks. Normalize GitHub SSH/HTTPS
case; preserve other hosts' ports and repository path case. Ignore sessions
without a reliable repository identity. For a new identifiable repository, ask
include or exclude and persist that decision in Scope settings before selecting
its sessions. Do not default to the current repository alone.

If a selected source is unavailable or unsupported, recommend postponing. The
person may explicitly continue with available sources. Record that override
and explain coverage. Leave the unread source's initialization and audited IDs
unchanged. A missing source is not an empty source. Never substitute a recent
local log for a missing remote session.

## Analyze and publish the report

Snapshot selected historical sessions by explicit native ID and root using the
existing `session_snapshot.py`. Reuse its per-agent cumulative accounting and
child ownership rules. An incomplete or unavailable snapshot becomes `failed`;
only a complete snapshot actually analyzed becomes `reviewed`. Assess efficiency,
correctness, tests, tool waits, workflow and repeated patterns across sessions.
Distinguish measured facts, bounded evidence and estimates. Missing usage,
duration or costs remain unknown, never zero. Native transcripts stay on their
source hosts. Scope receives metadata, findings and compact evidence, not logs.

Create a freely authored named HTML retrospective with the installed CLI's
retro publication flags, then use `retro apply FILE.json` to publish its report
and session inventory in pages of at most 200. Read `retro guide` for exact
commands and current bounds; the HTML SDK methods are documented below. Use the returned artifact/tab IDs and
version. Set `report.agent` to the confirmed current native identity. Publishing
the report records that agent exclusion immediately, so later discovery skips
the retro conversation even if the retro is interrupted. The metadata adapter maps `nativeSessionId` to `sessionId`,
`repositoryId` to `repository`, and `updatedAt` to `lastActivityAt`; native
unknown timestamps remain null. Native start time comes only from creation
metadata. Later activity cannot establish a missing start time. Report
`metadata_coverage.unreadable_headers` as the limit on related-agent coverage;
corrupt unrelated headers do not invalidate exact selected-session accounting.
Report each selected source/runtime with availability, initialization choice,
the original discovery cutoff, `inventoryComplete` and the exact `sessionCount`
stored for that coverage. Successful empty discovery uses `sessionCount: 0`.
Finish rejects partial inventories and mismatched counts. Put verified correction
destinations in `report.destinations`; memory destinations also require the
matching enabled configuration.

Use `window.scope.retros` to display findings, accept/edit/reject decisions,
comments and requests for deeper investigation. The HTML can be designed for
the particular audit. Domain decisions and notes live separately from its
HTML. Use normal `update NAME report.html` to change presentation. Do not
put a finish control in the HTML. Scope report history remains available for
inspection after finish; it does not resume an old run or archive transcripts.

Read the existing agent-connections reference and connect the installed
`retro watch NAME` command to this session's supported host destination under
its process manager. Verify the listener reports it is connected before
claiming feedback is connected. A listener without a host destination only
prints notices. If delivery is unavailable, say so and use Copy agent request
or a conversational request followed by `retro read NAME`. Do not keep a model
turn open while waiting. Commands need the desktop online; the hub does not
execute collection or queue retrospective commands.

Read durable pending requests and decisions when notified. Answer or perform
requested investigation, then resolve the request with evidence. A comment
alone may be discussion; a request explicitly asks for agent work. Do not treat
an HTML action or a request as permission to finish. Conflicting versions require
reading current state and reconsidering the proposed operation. On an uncertain
command outcome, reconcile or retry the exact request ID and identical payload
according to `retro guide`, never submit a new mutation blindly.

## Propose corrections and optional memory

Memory defaults off. General workflow and instruction corrections are still
available. Keep memory destinations hidden until they are configured and
verified. Refresh those capabilities before each retrospective and recheck before
applying accepted edits. A saved availability flag is the last observation, not
proof the CLI or destination still exists. Discover capabilities on the actual
destination host with the bundled
`retro_destinations.py`; a remote source's CLI cannot prove capability on the Mac
or another host. Claude memory uses the runtime-resolved directory, including
settings/environment overrides and trust rules. If unresolved, leave it
unavailable and obtain the directory from that runtime's `/memory` view. Scope
never enables or disables native auto memory.

Codex generated memory offers no supported CRUD contract here. Use supported
personal or repository instruction files instead. Show irudd-okf only when its
executable exists on the destination host; inspect installed help and use its
supported commands. There is no generic file-writing service in Scope.

For every proposal, show the exact final text, destination host, path or supported
store, and whether it is personal or belongs to the session's repository.
Ask when that scope is ambiguous. Associate project proposals with their
repository, including repositories outside the current session's checkout.
Respect comments and edits before applying anything. Accept/edit/reject decisions
remain visible and durable. An edit requires concrete final content and any
changed destination to be settled before application.

## Apply accepted changes last and finish conversationally

When the person says to finish, read the latest report, all session pages,
decisions and requests. Resolve any pending investigation or unclear edit first.
Apply the accepted corrections and optional memory changes through the external
agent on each verified destination host. Make agreed commits last, run relevant
validation and record outcomes with concrete evidence. Rejected proposals are
not applied. Report a failed accepted change honestly and let the person explicitly choose
whether to finish with that failed outcome or continue resolving it. Do not mark a claimed application successful from intention alone.

Publish the final report and outcomes, then submit the `finish` command with
that explicit conversational instruction. The desktop asks the mounted report
to flush pending writes and authored drafts before freezing it. A failed flush
leaves the report active and tracking unchanged. Saving a draft can advance the
version; read the new version and retry finish with a new request ID and the
same operator instruction. Unsent text remains an unsent draft, never a submitted
comment or request. Finish also rechecks current source/runtime and repository
inclusion, initialization and audited IDs. If another retro or a settings change
invalidated the selection, read current tracking/settings and revise coverage
and session statuses before trying again. Only successful finish commits staged
source/runtime initialization and whole IDs actually reviewed on available
sources. Failed sessions, unavailable sources and unreviewed sessions retain
their prior reviewed-session tracking and initialization. The retro-agent
exclusion was already recorded when the report was published.

An interrupted retrospective has no resume or recovery protocol. Its
reviewed-session markers and initialization remain unchanged. Its explicitly
published agent identity stays excluded. A later fresh coding session may start a new retrospective;
old final reports remain inspectable in history. Do not reopen a finished report
for edits or automatically launch an agent from history.

## Author the HTML SDK

Scope installs `window.scope.retros` before authored scripts run. `watch` receives
an immutable complete snapshot initially and after domain, state or theme
changes, and returns an unsubscribe function. It includes every session page
from the same report version. Derive the presentation from that snapshot; keep
dirty edits separate until a save succeeds. A finished snapshot has
`status: "finished"` and rejects domain, state and HTML writes.

```js
const retro = window.scope.retros;
const stop = retro.watch((snapshot) => {
  render(snapshot, {
    accept: (findingId) => retro.decide(findingId, "accept", snapshot.version),
    edit: (findingId, text, destination) =>
      retro.decide(
        findingId,
        {
          decision: "edit",
          text,
          destination,
        },
        snapshot.version,
      ),
    comment: (findingId, text) => retro.comment(findingId, text, snapshot.version),
    investigate: () =>
      retro.request(null, "Compare the test waits across all reviewed sessions.", snapshot.version),
  });
});
```

`render` is the authored app's renderer. Wire these callbacks to controls only
after the first snapshot arrives. Capture the displayed version when an edit
begins.

`decide` accepts `accept`, `edit` or `reject`, or an object with `decision`,
`text` and optional `destination`. Accept without edited text records the exact
published proposal. `findingId: null` associates a comment or request with the
whole report. Calls resolve to validated receipts after storage; a conflict
requires retaining the edit, reading the new snapshot and reconciling.

`state.read()` returns `{ version, value }`. `state.patch(value, expectedVersion)`
merges top-level JSON keys and uses the separate app-state version, not the
report version. Keep authored state within 32 KiB and 32 nesting levels. Save
form drafts there if they must survive HTML replacement, restart or finish.
The starter report saves unsent text and shows it read-only after finish.

`beforeClose(asyncCallback)` returns a cleanup function. Scope awaits registered
callbacks and issued writes before closing, replacing HTML or finishing. Flush
only pending edits owned by this report. A rejection keeps it open. The callback
must save authored drafts explicitly; Scope cannot infer arbitrary form state.

`history.list(after?)` returns a bounded history page with `entries` and `next`.
`history.open(entry.tabId)` restores and activates a retained completed report.
It does not resume or start an agent. Completed reports are also listed under
Retrospectives in Settings. The SDK has no finish, source execution, file-writing
or model method.
