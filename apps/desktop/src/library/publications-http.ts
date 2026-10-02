import type { IncomingMessage, ServerResponse } from "node:http";
import { ArtifactId, PublicationTabId, ScopeError, decode } from "@irudd-scope/protocol";
import {
  PublicationsCommand,
  PublicationsReply,
  MAX_PUBLICATIONS_REQUEST_BYTES,
  MAX_PUBLICATIONS_REPLY_BYTES,
} from "@irudd-scope/protocol/publications";
import type { PublicationStore } from "./publication-store.ts";

export async function handlePublicationsHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: PublicationStore,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/publications")) return false;
  if (url.search) throw new ScopeError(400, "Publication routes do not accept query parameters.");
  const content = /^\/v1\/publications\/([^/]+)\/operations\/([^/]+)\/content$/.exec(url.pathname);
  if (request.method === "GET" && content) {
    let id: string, operationId: string;
    try {
      id = decode(ArtifactId, content[1]);
      operationId = decode(PublicationTabId, content[2]);
    } catch {
      throw new ScopeError(400, "Invalid publication content address.");
    }
    const bytes = await store.content(id, operationId);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": bytes.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
    return true;
  }
  if (url.pathname !== "/v1/publications" || request.method !== "POST")
    throw new ScopeError(404, "Publication endpoint not found.");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PUBLICATIONS_REQUEST_BYTES)
      throw new ScopeError(413, "Publication command exceeds 256 KiB.");
    parts.push(chunk);
  }
  let command: PublicationsCommand;
  try {
    command = decode(PublicationsCommand, JSON.parse(Buffer.concat(parts).toString("utf8")));
  } catch {
    throw new ScopeError(400, "Invalid publication command.");
  }
  const reply = JSON.stringify(decode(PublicationsReply, await store.command(command)));
  if (Buffer.byteLength(reply) > MAX_PUBLICATIONS_REPLY_BYTES)
    throw new ScopeError(413, "Publication reply exceeds 1 MiB.");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(reply);
  return true;
}
