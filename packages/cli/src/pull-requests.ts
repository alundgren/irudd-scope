import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import {
  PullRequestsCommand,
  PullRequestsRepository,
  MAX_PULL_REQUESTS_REQUEST_BYTES,
} from "@irudd-scope/protocol/pull-requests";

export const PullRequestsGuide = {
  create:
    "Publish trusted HTML with add inbox.html --pull-requests --name repository-inbox, then run pull-requests configure repository-inbox OWNER/REPO. A partially configured publication can be configured later. Tabs start permanent. Update NAME FILE preserves the app kind, repository, and current PR data.",
  read: "Use pull-requests read NAME for the complete current snapshot and independent local and agent versions. Sync uses the desktop user's current gh login. No credentials or GitHub writes are supplied by the app. All commands require the desktop online, including through a paired hub.",
  repository:
    "The first successful sync may normalize a GitHub alias to the verified canonical OWNER/REPO; read the snapshot for the stored binding. This is allowed only before any successful inventory or cached PR rows. A successful empty inventory also pins the binding. Later renames or transfers do not silently change it: create another inbox for the new path. Failed sync keeps the prior binding and data.",
  write:
    "Include the snapshot tabId in every write. Write a validated request JSON file and run pull-requests apply FILE. Keep a stable UUID requestId and the same payload for uncertain retries. expectedVersion is noteVersion for note, snoozeVersion for snooze, reviewVersion for review, and agent.version for assessment. On conflict read the current snapshot and reconsider the change. Assessments and typed custom fields replace only the current agent values. GitHub refresh preserves local and agent values for retained open PRs. A complete refresh removes PRs no longer open and their local values.",
  appState:
    "Each inbox owns appState {version,value}, initially {version:0,value:{}}. state-set replaces the JSON object, state-patch replaces supplied top-level keys, and state-delete removes keys. Include expectedVersion from appState.version, name, tabId and a stable UUID requestId. Null is a stored value, nested objects and arrays replace whole values. Every accepted write increments version, including empty edits. Values fit within 32 KiB of UTF-8 JSON and 32 nested levels. State survives HTML updates, sync, restart and PR removal. scope.pullRequests.state exposes read(), set(value,expectedVersion), patch(value,expectedVersion), delete(keys,expectedVersion) and watch(callback), which emits frozen {operation,version,value} snapshots and live edits only to the owning inbox frames. Conflicts require reading and reconciling before another write.",
  detail:
    "Use pull-requests detail NAME NODE_ID to read the current commit's body, reviews, files and diff. Details are separate from the flat snapshot. Each file includes GitHub's reported blob sha, or null when unavailable; older replies can omit it. This identifies file contents rather than a hash of the diff text. Imported checks and merge status identify their observed commit; assessments identify their author, covered commit, and evidence. A changed head requires retrying detail.",
  reviewAndStack:
    "PR facts may include review {decision,hasApproval,headOid,observedAt} and stack. Missing fields mean unknown older cached data; stack:null means known standalone. hasApproval counts any active approval despite another reviewer's changes requested; dismissed or superseded approvals do not count. It does not imply merge permission. Native stack records contain nodeId,number,position,size,baseRefName,members {nodeId,number,position,state,draft},readyForReview,approved,observedAt. Aggregates cover all open native members before HTML filtering; closed/merged members are excluded. Stack approved can be null when approval is unknown. No branch inference or built-in views are added. Update desktop, CLI, and hub together for these additive fields.",
  externalLinks:
    "Inbox HTTP(S) links and direct window.open calls open in the default browser, while fragment links remain in the inbox. Authored click cancellation is respected. openExternal(url) returns a Promise and rejects invalid URLs, embedded credentials, or browser-launch errors. Automatic failures show a host alert and emit scope-pull-requests-external-error with detail {url,message}; direct HTTP(S) window.open returns null. Links work even before PR data loads. Ordinary HTML artifact navigation and popups retain their existing behavior.",
  htmlSdk:
    "Scope injects window.scope.pullRequests before authored scripts. watch((prs, context, sync) => render(prs)) delivers frozen current arrays, context {name,repository,viewer,theme}, and sync status; it returns unsubscribe. Configured live inboxes refresh automatically with adaptive intervals; the desktop SDK supplies optional sync.intervalMs, nextAttemptAt, and reason to explain timing. sync() is a coalesced fallback that obeys rate-limit waits. detail(nodeId, section, {headOid,baseOid}) returns the complete commit-bound detail and rejects a changed captured comparison; the commit pair is optional for older callers. loadDetails(nodeIds) loads 1 to 20 unique explicit IDs and returns per-ID {nodeId,captured,detail} or {nodeId,error} results. Successful results warm the temporary detail cache; retries may be needed after its time or response-size budget. It never selects the whole inventory or records inspection. watchDetail(nodeId,displayedHeadOid,displayedBaseOid,callback) subscribes to live body/review updates and returns unsubscribe; unsubscribe when closing or switching the pane. Updates identify the captured commits and retain the diff; errors leave prior content visible. saveNote(nodeId,text,expectedVersion), setSnooze(nodeId,{until,wakeOnNewCommit},expectedVersion), inspect(nodeId,displayedHeadOid,expectedVersion), and markReviewed(nodeId,displayedHeadOid,expectedVersion) resolve to {version}. Use local.noteVersion, local.snoozeVersion, or local.reviewVersion from the intent's snapshot. Capture a note version when editing begins, keep dirty text on conflict, and let the user reconcile; Undo uses the preceding operation's returned version. until:null clears a snooze. beforeClose(asyncCallback) registers pending edit flushes and returns cleanup. Rejected flushes keep the app open; arbitrary UI drafts are not persisted. Use ordinary JavaScript for named views over the array. Capture review navigation IDs and displayed commits until the user chooses newer code. All writes remain local to Scope; use Open on GitHub for public actions.",
  windows:
    "scope.windows.open({title,html,context}) opens caller-authored HTML in a movable, resizable window and resolves to its ID. Every window gets the same scope.pullRequests and scope.windows APIs plus frozen scope.window {id,openerId,context}; the main frame has id main and null context/openerId. Context and broadcast values must be JSON up to 64 KiB, nested at most 32 levels. HTML uses the artifact content limit. Up to eight windows can coexist per inbox. windows.close(id) flushes that window's beforeClose callbacks and pending local writes; omit id to close the current child. Failed flushes keep it open. windows.broadcast(value) sends transient {senderId,value} events to every mounted frame, including the sender; windows.watch(callback) returns unsubscribe and has no replay. All frames receive current snapshots and matching detail updates. Escape closes the focused child unless authored code consumes it. HTML replacement and quit flush all affected frames; temporary window state is not persisted. Each project supplies its own diff UI and loading/error behavior. Links retain the inbox's default-browser routing.",
  schema: Schema.toJsonSchemaDocument(PullRequestsCommand, { onExcessProperty: "error" }).schema,
};

export async function pullRequestsCommand(
  client: ScopeClient,
  positionals: string[],
  signal: AbortSignal,
) {
  const [, action, name, extra] = positionals;
  if (!name)
    throw new Error("Provide a pull request tab name or request file. Use pull-requests guide.");
  if (action === "apply") {
    if ((await stat(name)).size > MAX_PULL_REQUESTS_REQUEST_BYTES)
      throw new Error("Pull request command exceeds 256 KiB.");
    return client.pullRequests(
      decode(PullRequestsCommand, JSON.parse(await readFile(name, { encoding: "utf8", signal }))),
    );
  }
  const named = decode(ArtifactName, name);
  if (action === "read") return client.pullRequests({ action, name: named });
  const current = await client.pullRequests({ action: "read", name: named });
  if (current.type !== "snapshot") throw new Error("Expected a pull request snapshot.");
  const tabId = current.snapshot.tabId;
  if (action === "sync")
    return client.pullRequests({ action, name: named, tabId, requestId: randomUUID() });
  if (action === "detail" && extra)
    return client.pullRequests({
      action,
      name: named,
      tabId,
      requestId: randomUUID(),
      nodeId: extra,
    });
  if (action === "configure" && extra) {
    const parts = extra.split("/");
    if (parts.length !== 2) throw new Error("Use OWNER/REPO for a GitHub repository.");
    return client.pullRequests({
      action,
      name: named,
      tabId,
      requestId: randomUUID(),
      repository: decode(PullRequestsRepository, { owner: parts[0], name: parts[1] }),
    });
  }
  throw new Error("Use pull-requests guide, read, configure, sync, detail, or apply.");
}
