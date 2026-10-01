import type { IncomingMessage, ServerResponse } from "node:http";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  PullRequestsCommand,
  PullRequestsReply,
  MAX_PULL_REQUESTS_REQUEST_BYTES,
  MAX_PULL_REQUESTS_REPLY_BYTES,
} from "@irudd-scope/protocol/pull-requests";
import type { PullRequestStore } from "./pull-request-store.ts";

export async function handlePullRequestsHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: PullRequestStore,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/pull-requests")) return false;
  if (url.search) throw new ScopeError(400, "Pull request routes do not accept query parameters.");
  if (url.pathname !== "/v1/pull-requests" || request.method !== "POST")
    throw new ScopeError(404, "Pull request endpoint not found.");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PULL_REQUESTS_REQUEST_BYTES)
      throw new ScopeError(413, "Pull request command exceeds 256 KiB.");
    parts.push(chunk);
  }
  let command: PullRequestsCommand;
  try {
    command = decode(PullRequestsCommand, JSON.parse(Buffer.concat(parts).toString("utf8")));
  } catch {
    throw new ScopeError(400, "Invalid pull request command.");
  }
  const reply = JSON.stringify(decode(PullRequestsReply, await store.command(command)));
  if (Buffer.byteLength(reply) > MAX_PULL_REQUESTS_REPLY_BYTES)
    throw new ScopeError(413, "Pull request reply exceeds 32 MiB.");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(reply);
  return true;
}
