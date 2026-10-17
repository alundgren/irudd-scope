import type { IncomingMessage, ServerResponse } from "node:http";
import { BlobId, ScopeError, decode } from "@irudd-scope/protocol";
import {
  MAX_PROMPT_REQUEST_BYTES,
  PromptCommand,
  PromptItemId,
  PromptReply,
} from "@irudd-scope/protocol/prompts";
import type { PromptStore } from "./prompt-store.ts";

export async function handlePromptHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  prompts: PromptStore,
): Promise<boolean> {
  if (!url.pathname.startsWith("/v1/prompts")) return false;
  if (url.search) throw new ScopeError(400, "Prompt routes do not accept query parameters.");
  if (url.pathname === "/v1/prompts" && request.method === "POST") {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_PROMPT_REQUEST_BYTES)
        throw new ScopeError(413, "Prompt command exceeds 12 MiB.");
      parts.push(chunk);
    }
    let command;
    try {
      command = decode(PromptCommand, JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch {
      throw new ScopeError(400, "Invalid prompt command.");
    }
    const reply = decode(PromptReply, await prompts.command(command));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(reply));
    return true;
  }
  if (url.pathname === "/v1/prompts/export" && request.method === "GET") {
    const bytes = await prompts.exportLibrary();
    response.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": bytes.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'attachment; filename="scope-prompt-library.zip"',
    });
    response.end(bytes);
    return true;
  }
  const match = /^\/v1\/prompts\/items\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname);
  if (!match || request.method !== "GET") throw new ScopeError(404, "Prompt endpoint not found.");
  let itemId, imageId;
  try {
    itemId = decode(PromptItemId, match[1]);
    imageId = decode(BlobId, match[2]);
  } catch {
    throw new ScopeError(400, "Invalid prompt item or image ID.");
  }
  const { image, bytes } = await prompts.image(itemId, imageId);
  response.writeHead(200, {
    "Content-Type": image.mediaType,
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
  return true;
}
