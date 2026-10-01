import type { IncomingMessage, ServerResponse } from "node:http";
import { ArtifactName, BlobId, Revision, ScopeError, decode } from "@irudd-scope/protocol";
import { PlanCommand, PlanReply, MAX_PLAN_REQUEST_BYTES } from "@irudd-scope/protocol/plan";
import type { PlanStore } from "./plan-store.ts";

export async function handlePlanHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  plans: PlanStore,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/plans")) return false;
  if (url.search) throw new ScopeError(400, "Plan routes do not accept query parameters.");
  if (url.pathname === "/v1/plans" && request.method === "POST") {
    let size = 0;
    const parts: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_PLAN_REQUEST_BYTES) throw new ScopeError(413, "Plan request exceeds 48 MiB.");
      parts.push(chunk);
    }
    let command: PlanCommand;
    try {
      command = decode(PlanCommand, JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch {
      throw new ScopeError(400, "Invalid plan command.");
    }
    const reply = decode(PlanReply, await plans.command(command));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(reply));
    return true;
  }
  const match = /^\/v1\/plans\/([^/]+)\/(?:images\/([^/]+)|revisions\/([^/]+)\/content)$/.exec(
    url.pathname,
  );
  if (!match || request.method !== "GET") throw new ScopeError(404, "Plan endpoint not found.");
  let name: string;
  let id: string | undefined;
  let revision: number | undefined;
  try {
    name = decode(ArtifactName, decodeURIComponent(match[1]));
    if (match[2]) id = decode(BlobId, match[2]);
    else revision = decode(Revision, Number(match[3]));
  } catch {
    throw new ScopeError(400, "Invalid plan name, image ID, or revision.");
  }
  const bytes = id ? await plans.image(name, id) : await plans.content(name, revision!);
  response.writeHead(200, {
    "Content-Type": id ? "image/png" : "text/html; charset=utf-8",
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "attachment",
  });
  response.end(bytes);
  return true;
}
