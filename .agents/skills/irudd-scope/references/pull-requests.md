# PR inbox authoring

Create and customize inboxes from the current coding session with the Scope
CLI. Write the HTML app, publish it as a named `pull-requests` artifact, and
configure its repository. The desktop supplies GitHub data and durable local
state; the app owns rendering, named views, and temporary interaction state.

Read the sections needed for your task:

- [Create or update an inbox](#create-or-update-an-inbox)
- [Snapshot and PR data](#snapshot-and-pr-data)
- [HTML SDK](#html-sdk)
- [Agent commands](#agent-commands)
- [Conflicts and operating limits](#conflicts-and-operating-limits)

## Create or update an inbox

Use the entry point selected in `SKILL.md`. These examples use the installed
`irudd-scope` command. No desktop button is required.

```sh
irudd-scope pull-requests guide
irudd-scope add inbox.html --pull-requests --name repository-inbox --title "PR inbox"
irudd-scope pull-requests configure repository-inbox OWNER/REPO
irudd-scope pull-requests sync repository-inbox
```

`guide` works without a connection and prints the installed command JSON
schema and SDK guidance. `add` requires an HTML file and a name, supplied by
`--name NAME` or generated with `--named`. Announce the returned immutable
name. A new inbox starts permanent. The name and artifact kind cannot change.
Keep artifact IDs and names distinct from the snapshot's desktop `tabId` UUID.

All `pull-requests` commands other than `guide` need an online desktop, directly
or through a paired hub. Initial publication can use the ordinary hub
queue; wait for delivery before configuring it. The awake desktop runs its
installed `gh` under the Mac user's current GitHub login. A remote agent does
not need a separate GitHub login to use the inbox commands. Only `github.com`
repositories are supported.

`configure` binds the repository and starts automatic desktop refresh;
`read` returns cached state without refreshing GitHub. `sync`
returns a snapshot even when GitHub refresh fails. Check `snapshot.sync.state`,
`error`, and `lastSuccessAt` before reporting that the inbox has loaded current
PRs. Tab selection and the app's Sync action request coalesced refreshes.
The desktop polls configured live inboxes while Scope is running and awake.
Visible inboxes target 30 seconds, inspected PRs 15 seconds, and background
repositories five minutes; measured cost and quota can lengthen these targets.
Matching inboxes share GitHub reads. The 500-point hourly account target delays
new automatic jobs; admitted jobs finish. Manual Sync and detail reads bypass
that routine wait but still respect actual GitHub quota reserve and throttling.

If publication succeeds but configuration fails, configure the existing name
instead of publishing again. The same repository can be configured again.
Changing repositories requires a new named inbox. The first complete inventory
may normalize an alias to GitHub's verified canonical owner/name. A successful
inventory, including an empty one, pins that path. Later repository renames or
transfers require a new inbox. Read the returned snapshot for the actual binding.

For an existing inbox:

```sh
irudd-scope pull-requests read repository-inbox
irudd-scope update repository-inbox inbox.html
```

HTML updates retain repository, PR facts, notes, snoozes, review baselines, and
agent values. Use the existing name rather than creating another tab. Ordinary
publication revision checks still apply.

Write a complete HTML document with embedded resources or reachable URLs.
Adjacent files are not uploaded. Scope injects `window.scope.pullRequests`
before authored scripts. Do not embed credentials, a separate GitHub client,
or a saved PR inventory in the HTML. There is no CLI command to export the
desktop's built-in starter app; agents author their own HTML using the SDK.

Inbox HTTP(S) links and direct `window.open` calls open in the system's default
browser, preserving its GitHub login. In-page anchors stay in the inbox.
Authored click handlers can cancel navigation with `preventDefault()`.
For explicit actions, call `window.scope.pullRequests.openExternal(url)` and
handle its rejected Promise. It accepts HTTP(S) URLs without embedded
credentials. Automatic link failures show a host alert and dispatch
`scope-pull-requests-external-error` on the inbox window with
`event.detail = { url, message }`. Direct HTTP(S) `window.open` returns null;
the browser window is outside Electron. Ordinary HTML artifact navigation
and popups are unaffected.

This minimal app displays live titles and a Sync action:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>PR inbox</title>
  </head>
  <body>
    <h1 id="repository">PR inbox</h1>
    <button id="sync" type="button">Sync</button>
    <p id="status" role="status"></p>
    <ul id="prs"></ul>
    <script>
      const inbox = window.scope.pullRequests;
      const status = document.getElementById("status");
      const syncButton = document.getElementById("sync");
      inbox.watch((prs, context, sync) => {
        document.documentElement.dataset.theme = context.theme;
        document.getElementById("repository").textContent = context.repository
          ? `${context.repository.owner}/${context.repository.name}`
          : "Repository not configured";
        syncButton.disabled = sync.state === "syncing";
        status.textContent =
          sync.error ?? (sync.state === "syncing" ? "Syncing…" : `${prs.length} open PRs`);
        document.getElementById("prs").replaceChildren(
          ...prs.map((pr) => {
            const row = document.createElement("li");
            const link = document.createElement("a");
            link.href = pr.url;
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = `#${pr.number} ${pr.title}`;
            row.append(link);
            return row;
          }),
        );
      });
      syncButton.onclick = async () => {
        try {
          await inbox.sync();
        } catch (error) {
          status.textContent = error.message;
        }
      };
    </script>
  </body>
</html>
```

## Snapshot and PR data

`pull-requests read NAME` returns `{ type: "snapshot", snapshot }`. Other
commands also return this envelope, except `detail`. A snapshot contains:

| Field        | Meaning                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `artifact`   | Publication metadata, including `id`, immutable `name`, `kind`, and HTML `revision`.                                           |
| `tabId`      | Desktop tab UUID. Include it in agent commands to prevent writes to a replacement tab with a reused name.                      |
| `generation` | Inbox change counter. It is separate from HTML revision and each mutation's version.                                           |
| `repository` | `{ owner, name }`, or `null` before configuration.                                                                             |
| `viewer`     | Desktop GitHub login, or `null` before a successful refresh.                                                                   |
| `sync`       | `{ state, updatedAt, lastSuccessAt, error }`. The HTML SDK also supplies adaptive `intervalMs`, `nextAttemptAt`, and `reason`. |
| `prs`        | Complete flat array of currently cached open PR records, including drafts.                                                     |

Each PR has the following GitHub facts at its top level:

| Fields                                   | Types and meaning                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `nodeId`, `number`                       | GitHub node ID string and PR number. Commands use `nodeId`, not the number or array index.                           |
| `title`, `url`                           | Title and `https://github.com/OWNER/REPO/pull/NUMBER` URL.                                                           |
| `author`, `labels`, `requestedReviewers` | Nullable author login, label string array, requested reviewer string array.                                          |
| `headOid`, `headRefName`, `baseOid`      | Head commit ID, head branch name, and base commit ID.                                                                |
| `draft`                                  | Boolean.                                                                                                             |
| `additions`, `deletions`, `changedFiles` | Nonnegative integer counts.                                                                                          |
| `createdAt`, `updatedAt`                 | GitHub UTC timestamps.                                                                                               |
| `hasUnresolvedConversations`             | `true` if a review thread is unresolved, `false` after a complete read finds none, `null` if unavailable.            |
| `merge`                                  | `{ status, headOid, baseOid, observedAt }`. Status is `unknown`, `clear`, or `conflicting`.                          |
| `checks`                                 | `{ status, headOid, observedAt }`. Status is `unknown`, `pending`, `passing`, or `failing`; `headOid` can be `null`. |
| `review`                                 | Optional `{ decision, hasApproval, headOid, observedAt }`. See approval semantics below.                             |
| `stack`                                  | Optional native stack record, or null for a known standalone PR. See stack semantics below.                          |

`review.decision` is GitHub's overall `approved`, `changes-requested`, or
`review-required` decision, or null when GitHub returns no decision.
`review.hasApproval` is independent: any reviewer's active approval counts,
even if another reviewer requests changes. Dismissed or superseded approvals
do not count. Null means the head changed during retrieval. The recorded
`headOid` identifies the PR head observed, not the commit a reviewer approved.
Approval does not imply CI success or permission to merge.

`stack` uses native GitHub membership, not matching branch names. It contains
`nodeId`, repository-local `number`, this PR's `position`, total `size`, the
stack's ultimate `baseRefName`, ordered `members`, `readyForReview`, `approved`,
and `observedAt`. Each member has `nodeId`, `number`, `position`, `state`
(`open`, `closed`, or `merged`), and `draft`. Native position 1 is nearest the
target branch. Closed and merged members stay in this list but are excluded
from the aggregate flags. Every open member must be out of draft for
`readyForReview`; every open member must have an active approval for `approved`.
`approved` is null when an approval is unknown and none is known to be absent.

Stack calculations include every open native member before your HTML
applies filters or snoozes. A hidden draft still blocks stack readiness.
Incomplete membership or review reads fail the refresh and keep the saved
facts; check sync state and observation timestamps before relying on them.

The lightweight initial load omits review and stack fields until enrichment completes.
A focused PR refresh re-observes every open member of its native stack. Other
rows can retain older observations; use `stack.observedAt` for that stack record.

Older saved records can omit `review` and `stack`. Treat missing fields as
unknown; `stack === null` is the known standalone case. For example:

```js
const hasApproval = pr.review?.hasApproval ?? null;
const readyForReview =
  pr.stack === undefined ? null : pr.stack === null ? !pr.draft : pr.stack.readyForReview;
const openStackMembers = pr.stack?.members.filter((member) => member.state === "open");
```

Update desktop, CLI, and hub together. Older strict protocol clients reject
these added fields in newly enriched replies. Existing authored JavaScript
can keep using the flat array and choose its own views and filters.

Each PR also contains Scope-owned data:

| Field                 | Value                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `local.note`          | String, initially empty.                                                                                       |
| `local.noteVersion`   | Note version, initially `0`.                                                                                   |
| `local.snooze`        | `null` or `{ until, wakeOnNewCommit, headOid }`.                                                               |
| `local.snoozeVersion` | Snooze version, initially `0`.                                                                                 |
| `local.inspected`     | `null` or `{ headOid, at }`, recording the last inspected commit.                                              |
| `local.reviewed`      | `null` or `{ headOid, at }`, recording an explicit local review mark.                                          |
| `local.reviewVersion` | Shared inspection/review version, initially `0`.                                                               |
| `agent.version`       | Agent assessment/custom-field version, initially `0`.                                                          |
| `agent.assessment`    | `null` or `{ text, author, headOid, evidenceIds, discussionUpdatedAt, createdAt }`.                            |
| `agent.customFields`  | Array of `{ key, type, value }`. Type is `text`, `number`, or `boolean`; value must match it. Keys are unique. |

Timestamps use UTC `YYYY-MM-DDTHH:mm:ssZ` or
`YYYY-MM-DDTHH:mm:ss.sssZ`. Commit IDs contain 40 to 64 lowercase hexadecimal
characters. Use returned IDs and versions exactly.

An assessment's `author` identifies its writer, `headOid` identifies the commit
it covers, and `evidenceIds` records evidence identifiers. `discussionUpdatedAt`
is a nullable timestamp for the discussion the agent considered. `createdAt`
is supplied by the agent. GitHub refresh does not rewrite an assessment to
claim it covers a newer commit.

`detail NAME NODE_ID` returns
`{ type: "detail", tabId, nodeId, detail }`. The detail object has `headOid`,
`body`, `diff`, `fetchedAt`, and these arrays:

- `reviews`: `{ id, author, state, body, submittedAt, headOid }`. Author,
  submission time, and review commit can be `null`.
- `files`: `{ path, additions, deletions, status }`.

Details come from GitHub for the selected head commit and remain separate from
the flat inventory. Scope retains no detail history. A changed head during
retrieval rejects the read; read current state and request details again.

## HTML SDK

`window.scope.pullRequests` exposes these methods:

| Method                                                           | Result and behavior                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch(callback)`                                                | Calls `callback(prs, context, sync)` when the initial snapshot arrives and on snapshot/theme changes. Returns an unsubscribe function.                                                                        |
| `sync()`                                                         | Promise that requests GitHub refresh. Refresh errors appear in the watched `sync` state; transport errors reject.                                                                                             |
| `watchDetail(nodeId, headOid, baseOid, callback)`                | Subscribes the inspected PR to live body/review updates for the captured commit pair. Returns unsubscribe; the newest subscription identifies the inspected PR.                                               |
| `detail(nodeId, section, {headOid,baseOid})`                     | Promise of the complete detail object above. `section` is an app hint, not a response filter. Supply the captured commit pair to reject a comparison that changed before the read; older callers may omit it. |
| `openExternal(url)`                                              | Promise that opens an HTTP(S) URL in the default browser; rejects invalid URLs or browser-launch failures.                                                                                                    |
| `saveNote(nodeId, text, expectedVersion)`                        | Promise of `{ version }`. Use `local.noteVersion`.                                                                                                                                                            |
| `setSnooze(nodeId, { until, wakeOnNewCommit }, expectedVersion)` | Promise of `{ version }`. Use `local.snoozeVersion`. The host supplies the current head commit. `until: null` clears the snooze.                                                                              |
| `inspect(nodeId, displayedHeadOid, expectedVersion)`             | Promise of `{ version }`. Use `local.reviewVersion`. Records inspection only.                                                                                                                                 |
| `markReviewed(nodeId, displayedHeadOid, expectedVersion)`        | Promise of `{ version }`. Use `local.reviewVersion`. Records an explicit local review mark.                                                                                                                   |
| `beforeClose(asyncCallback)`                                     | Registers a pending-edit flush. Returns a cleanup function.                                                                                                                                                   |

`watch` context is `{ name, repository, viewer, theme }`, with theme `light`
or `dark`. Repository, viewer, and sync have the same meanings as in a CLI
snapshot. The array and all nested records are frozen. Derive views with
ordinary predicates, sorting a copied array rather than mutating `prs`.
Named views, selection, and review navigation belong to the HTML app.

`watchDetail` updates include `tabId`, `nodeId`, captured `headOid` and `baseOid`,
`body`, `reviews`, `fetchedAt`, and `error`. Error updates omit body/reviews; keep
the prior content. Unsubscribe when closing or switching the pane. Initial
`detail` loading still supplies the diff and files; live reviews do not replace them.

For example, filter review requests with
`context.viewer !== null && pr.requestedReviewers.includes(context.viewer)`.
A snooze is active while
`pr.local.snooze !== null && Date.parse(pr.local.snooze.until) > Date.now()`.
Scope clears a snooze on sync when `wakeOnNewCommit` is true and its recorded
head differs from the new head. Time passage alone does not emit a snapshot;
an app displaying expiration as it happens needs a local timer.

Compare commit IDs before displaying freshness. Checks apply when
`pr.checks.headOid === pr.headOid`; otherwise display unknown. Merge status
applies when both its head and base match the current PR. A local review or
assessment covers current code only when its recorded head matches. An unknown
status or nullable fact must not be displayed as passing or absent.

Capture a note's version when editing begins. Keep the dirty text and that
version through incoming snapshots; on conflict, let the human reconcile the
new saved note. Use the preceding operation's returned version for Undo so it
cannot overwrite a later edit from another client.

Keep selected PR IDs, the displayed commit, and review-navigation IDs stable
while a person inspects code. Offer an explicit action to load newer code.
Opening a review pane should call `inspect`; call `markReviewed` only after the
person explicitly marks that displayed commit reviewed. A newer inventory must
not silently make a review mark cover a commit the person has not inspected.

Register `beforeClose` to save dirty notes or other pending durable edits.
Scope awaits callbacks and already issued local writes before closing the tab
or replacing its HTML revision. A rejected flush keeps the app open. Callbacks
must finish within the host's eight-second flush deadline. Arbitrary UI drafts
are not persisted, so keep them in memory and save supported durable values
through the SDK. Do not add renderer localStorage persistence.

The HTML SDK has no assessment writer. Agents write assessments and typed
custom fields through the CLI. All SDK writes stay local to Scope. Provide
Open on GitHub links for public comments, GitHub reviews, and merges.

## Agent commands

Convenience commands read the current tab identity before sending their request:

```sh
irudd-scope pull-requests read repository-inbox
irudd-scope pull-requests configure repository-inbox OWNER/REPO
irudd-scope pull-requests sync repository-inbox
irudd-scope pull-requests detail repository-inbox NODE_ID
```

For local mutations, export the current snapshot to an explicit local file:

```sh
irudd-scope pull-requests read repository-inbox > inbox.snapshot.json
irudd-scope pull-requests apply command.json
```

`apply` validates and sends one JSON command unchanged. Obtain the exact schema
from `pull-requests guide`. Every command except `read` requires `name`, the
snapshot's `tabId`, and a UUID `requestId`. Each PR mutation also requires
`nodeId` and `expectedVersion` from the relevant PR record.

| `action`     | Additional fields                                                                                      | Version source        |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------- |
| `read`       | `name` only.                                                                                           | None.                 |
| `configure`  | `repository: { owner, name }`.                                                                         | None.                 |
| `sync`       | None.                                                                                                  | None.                 |
| `detail`     | `nodeId`.                                                                                              | None.                 |
| `note`       | `text`. Empty text clears the note.                                                                    | `local.noteVersion`   |
| `snooze`     | `snooze: null` to clear, or `{ until, wakeOnNewCommit, headOid }`. The head must match the current PR. | `local.snoozeVersion` |
| `review`     | `baseline: "inspected"` or `"reviewed"`, plus the actual displayed `headOid`.                          | `local.reviewVersion` |
| `assessment` | `assessment: null` or the complete assessment object, plus the complete `customFields` array.          | `agent.version`       |

This assessment example uses illustrative IDs. Replace the tab UUID, node ID,
head commit, expected version, author, evidence, and timestamps from the real
read and your work. Generate a new request UUID once and retain the resulting
file for uncertain retries.

```json
{
  "action": "assessment",
  "name": "repository-inbox",
  "tabId": "11111111-1111-4111-8111-111111111111",
  "requestId": "22222222-2222-4222-8222-222222222222",
  "nodeId": "PR_example",
  "expectedVersion": 0,
  "assessment": {
    "text": "The migration needs a rollback test before merge.",
    "author": "review-agent",
    "headOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "evidenceIds": ["migration-rollback-review"],
    "discussionUpdatedAt": null,
    "createdAt": "2026-10-02T12:00:00.000Z"
  },
  "customFields": [{ "key": "needsRollbackTest", "type": "boolean", "value": true }]
}
```

Assessment commands replace both the current assessment and the entire custom
field array. Preserve values you still want to keep. `assessment: null` clears
the assessment; `customFields: []` clears fields. These commands do not replace
GitHub facts, human notes, snoozes, or local review marks. Never invent evidence
or substitute the newest head ID for code you did not examine.

## Conflicts and operating limits

After an uncertain local mutation outcome, retry the exact original file with
the same UUID and payload. Scope retains mutation receipts for the PR or tab
lifetime and does not apply identical retries twice. A reused UUID with a
different payload returns 409. Sync and detail fetch current GitHub data; they
do not replay an earlier inventory or detail result.

A version conflict requires a fresh read and reconsideration. Preserve the
original edit until you have compared it with current values. Submit the
reconsidered command with a new UUID and current relevant version. Do not
silently change `expectedVersion` and overwrite another writer. A tab UUID
mismatch also requires checking whether the original inbox was deleted and
replaced. Trust successful receipts; read again when needed for another task
or conflict recovery.

A complete sync removes PRs no longer open and their Scope-owned data. Failed
or partial reads preserve cached facts and local values. Successful refreshes
preserve local and agent data for retained PRs. There is no closed PR archive.
Closing the permanent inbox retains it in Trashcan; restore it before more
commands. Permanent deletion removes its data.

Command files are limited to 256 KiB and complete replies to 32 MiB. There is
no inventory PR count cap; an oversized snapshot fails rather than truncating
the list. Notes and assessment text allow 20,000 characters. Assessments allow
100 evidence IDs and 50 custom fields; authors, evidence IDs, and field keys
allow 512 characters. Text custom-field values allow 20,000 characters; numeric
values must be finite. Detail body allows 256 Ki characters, diff allows
2,097,152 characters, and files and reviews allow 10,000 entries each. Oversized
details fail; retain the PR's GitHub link as a fallback.

Live events carry artifact ID, name, and generation as transient change notices.
Read a complete snapshot after reconnecting. The HTML host handles these reads
and delivers them through `watch`. The hub only forwards PR commands while the
desktop is connected; it does not cache PR snapshots or queue local mutations.
