import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import {
  MAX_WORKSPACE_REQUEST_BYTES,
  WorkspaceBoardRef,
  WorkspaceCommand,
  WorkspaceRepository,
} from "@irudd-scope/protocol/github-workspace";

export const GitHubWorkspaceGuide = {
  create:
    "Publish trusted HTML with `add board.html --github-workspace --name my-workspace`, then run `github-workspace configure my-workspace OWNER/REPO [user:OWNER/NUM | org:OWNER/NUM | none]`.",
  read: "Use `github-workspace read NAME` for the complete current snapshot (milestones, issues, PRs, optional board overlay, transitions, and local/agent versions).",
  sync: "Use `github-workspace sync NAME` to trigger an immediate refresh using the desktop user's gh login. Reading a GitHub Project v2 board requires the `read:project` scope (`gh auth refresh -s read:project`).",
  detail:
    "Use `github-workspace pr-detail NAME NODE_ID` for PR diff/files/reviews or `github-workspace issue-detail NAME NODE_ID` for issue body, comments, and state/relation timeline.",
  apply:
    "Run `github-workspace apply REQUEST.json` for validated state, note, snooze, review, or assessment writes.",
  schema: Schema.toJsonSchemaDocument(WorkspaceCommand, { onExcessProperty: "error" }).schema,
};

function parseBoardRef(raw: string): WorkspaceBoardRef | null {
  if (raw === "none" || raw === "null") return null;
  const match = /^(org|organization|user):([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(\d+)$/i.exec(raw);
  if (!match) throw new Error("Board format must be user:OWNER/NUMBER, org:OWNER/NUMBER, or none.");
  return decode(WorkspaceBoardRef, {
    ownerType: match[1]!.toLowerCase().startsWith("org") ? "organization" : "user",
    owner: match[2]!,
    number: Number(match[3]!),
  });
}

export async function githubWorkspaceCommand(
  client: ScopeClient,
  positionals: string[],
  signal: AbortSignal,
) {
  const [, action, name, extra, boardArg] = positionals;
  if (!name)
    throw new Error(
      "Provide a GitHub workspace tab name or request file. Use github-workspace guide.",
    );
  if (action === "apply") {
    if ((await stat(name)).size > MAX_WORKSPACE_REQUEST_BYTES)
      throw new Error("GitHub workspace command exceeds 256 KiB.");
    return client.githubWorkspace(
      decode(WorkspaceCommand, JSON.parse(await readFile(name, { encoding: "utf8", signal }))),
    );
  }
  const named = decode(ArtifactName, name);
  if (action === "read") return client.githubWorkspace({ action, name: named });
  const current = await client.githubWorkspace({ action: "read", name: named });
  if (current.type !== "snapshot") throw new Error("Expected a GitHub workspace snapshot.");
  const tabId = current.snapshot.tabId;
  if (action === "sync")
    return client.githubWorkspace({ action, name: named, tabId, requestId: randomUUID() });
  if (action === "pr-detail" && extra)
    return client.githubWorkspace({
      action: "pr-detail",
      name: named,
      tabId,
      requestId: randomUUID(),
      nodeId: extra,
    });
  if (action === "issue-detail" && extra)
    return client.githubWorkspace({
      action: "issue-detail",
      name: named,
      tabId,
      requestId: randomUUID(),
      nodeId: extra,
    });
  if (action === "configure" && extra) {
    const parts = extra.split("/");
    if (parts.length !== 2) throw new Error("Use OWNER/REPO for a GitHub repository.");
    return client.githubWorkspace({
      action: "configure",
      name: named,
      tabId,
      requestId: randomUUID(),
      repository: decode(WorkspaceRepository, { owner: parts[0], name: parts[1] }),
      ...(boardArg !== undefined ? { board: parseBoardRef(boardArg) } : {}),
    });
  }
  throw new Error(
    "Use github-workspace guide, read, configure, sync, pr-detail, issue-detail, or apply.",
  );
}
