import type { IncomingMessage, ServerResponse } from "node:http";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  HARNESSES_ROUTES,
  HarnessesReply,
  HarnessesTarget,
  MAX_HARNESSES_REQUEST_BYTES,
} from "@irudd-scope/protocol/harnesses";

export type HarnessesHttp = {
  read: (machine: HarnessesTarget) => Promise<HarnessesReply>;
  scan: (machine: HarnessesTarget) => Promise<HarnessesReply>;
};

export async function handleHarnessesHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  harnesses: HarnessesHttp | undefined,
): Promise<boolean> {
  const route = `${request.method} ${url.pathname}`;
  if (url.pathname !== HARNESSES_ROUTES.read && url.pathname !== HARNESSES_ROUTES.scan)
    return false;
  if (!harnesses) throw new ScopeError(503, "Harnesses are unavailable. Open Scope and retry.");
  let reply: HarnessesReply;
  if (route === `GET ${HARNESSES_ROUTES.read}`) reply = await harnesses.read(readTarget(url));
  else if (route === `POST ${HARNESSES_ROUTES.scan}` && !url.search)
    reply = await harnesses.scan(await scanTarget(request));
  else throw new ScopeError(404, "Harness endpoint not found.");
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(decode(HarnessesReply, reply)));
  return true;
}

function readTarget(url: URL): HarnessesTarget {
  const machines = url.searchParams.getAll("machine");
  if ([...url.searchParams.keys()].some((name) => name !== "machine") || machines.length > 1)
    throw new ScopeError(400, "Harness reads accept one machine query parameter.");
  return target(machines[0] ?? "local");
}

async function scanTarget(request: IncomingMessage): Promise<HarnessesTarget> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HARNESSES_REQUEST_BYTES)
      throw new ScopeError(413, "Harness scan request exceeds 4 KiB.");
    parts.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new ScopeError(400, "Invalid harness scan request.");
  }
  const keys = body && typeof body === "object" ? Object.keys(body) : null;
  if (!keys || keys.some((key) => key !== "machine"))
    throw new ScopeError(400, "Invalid harness scan request.");
  return target((body as { machine?: unknown }).machine);
}

function target(machine: unknown): HarnessesTarget {
  try {
    return decode(HarnessesTarget, machine);
  } catch {
    throw new ScopeError(400, "Scope reads harnesses only for --machine local.");
  }
}
