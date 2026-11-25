import type { IncomingMessage, ServerResponse } from "node:http";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  MAX_WORKSPACE_REPLY_BYTES,
  MAX_WORKSPACE_REQUEST_BYTES,
  WorkspaceCommand,
  WorkspaceReply,
} from "@irudd-scope/protocol/github-workspace";
import type { GitHubWorkspaceStore } from "./github-workspace-store.ts";

export async function handleGitHubWorkspaceHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: GitHubWorkspaceStore,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/github-workspace")) return false;
  if (url.search)
    throw new ScopeError(400, "GitHub workspace routes do not accept query parameters.");
  if (url.pathname !== "/v1/github-workspace" || request.method !== "POST")
    throw new ScopeError(404, "GitHub workspace endpoint not found.");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_WORKSPACE_REQUEST_BYTES)
      throw new ScopeError(413, "GitHub workspace command exceeds 256 KiB.");
    parts.push(chunk);
  }
  let command: WorkspaceCommand;
  try {
    command = decode(WorkspaceCommand, JSON.parse(Buffer.concat(parts).toString("utf8")));
  } catch {
    throw new ScopeError(400, "Invalid GitHub workspace command.");
  }
  const value = decode(WorkspaceReply, await store.command(command));
  const reply = JSON.stringify(value);
  if (Buffer.byteLength(reply) > MAX_WORKSPACE_REPLY_BYTES)
    throw new ScopeError(413, "GitHub workspace reply exceeds 32 MiB.");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(reply);
  return true;
}
