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
  detail:
    "Use pull-requests detail NAME NODE_ID to read the current commit's body, reviews, files and diff. Details are separate from the flat snapshot. Imported checks and merge status identify their observed commit; assessments identify their author, covered commit, and evidence. A changed head requires retrying detail.",
  htmlSdk:
    "Scope injects window.scope.pullRequests before authored scripts. watch((prs, context, sync) => render(prs)) delivers frozen current arrays, context {name,repository,viewer,theme}, and sync status; it returns unsubscribe. sync() refreshes; detail(nodeId, section) returns the complete commit-bound detail. saveNote(nodeId,text,expectedVersion), setSnooze(nodeId,{until,wakeOnNewCommit},expectedVersion), inspect(nodeId,displayedHeadOid,expectedVersion), and markReviewed(nodeId,displayedHeadOid,expectedVersion) resolve to {version}. Use local.noteVersion, local.snoozeVersion, or local.reviewVersion from the intent's snapshot. Capture a note version when editing begins, keep dirty text on conflict, and let the user reconcile; Undo uses the preceding operation's returned version. until:null clears a snooze. beforeClose(asyncCallback) registers pending edit flushes and returns cleanup. Rejected flushes keep the app open; arbitrary UI drafts are not persisted. Use ordinary JavaScript for named views over the array. Capture review navigation IDs and displayed commits until the user chooses newer code. All writes remain local to Scope; use Open on GitHub for public actions.",
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
