import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ArtifactWrite,
  PublicationRequest,
  MAX_CONTENT_BYTES,
  MAX_METADATA_BYTES,
  ScopeError,
  decode,
} from "@irudd-scope/protocol";
import type { PublicationQueue } from "./publication-queue.ts";

export async function readBody(request: IncomingMessage, limit: number) {
  if (Number(request.headers["content-length"]) > limit)
    throw new ScopeError(413, "Request exceeds the size limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ScopeError(413, "Request exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class BufferedPublication {
  private uploads = 0;
  constructor(
    private readonly queue: PublicationQueue,
    private readonly reply: (response: ServerResponse, status: number, value: unknown) => void,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    offline: boolean,
    paired: boolean,
  ) {
    const generation = this.queue.generation;
    const checkPairing = () => {
      if (generation !== this.queue.generation)
        throw new ScopeError(
          409,
          "Pairing changed during this upload. Publish explicitly to the current Mac.",
        );
    };
    const path = request.url ?? "";
    const reservation = /^\/v1\/artifacts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\/tab$/.exec(path);
    if (
      reservation &&
      request.method === "POST" &&
      (this.queue.get(reservation[1]) ||
        (offline && request.headers["scope-buffer-publication"] === "1"))
    ) {
      if (request.headers["scope-buffer-publication"] !== "1")
        throw new ScopeError(
          409,
          "This artifact has a buffered publication. Inspect the hub queue before publishing synchronously.",
        );
      if (!paired)
        throw new ScopeError(503, "Pair this hub with Scope before buffering publications.");
      const input = decode(
        PublicationRequest,
        JSON.parse((await readBody(request, 1024)).toString()),
      );
      checkPairing();
      this.reply(response, 201, {
        tabId: this.queue.reserve(reservation[1], input.expectedRevision),
      });
      return true;
    }
    const upload = /^\/v1\/tabs\/([0-9a-f-]{36})\/blobs$/.exec(path);
    if (upload && request.method === "POST" && this.queue.hasTab(upload[1])) {
      if (this.uploads >= 4)
        throw new ScopeError(503, "The hub is busy uploading buffered tabs. Try again.");
      this.uploads++;
      try {
        const bytes = await readBody(request, MAX_CONTENT_BYTES);
        checkPairing();
        this.reply(response, 201, {
          blob: this.queue.upload(upload[1], bytes),
        });
      } finally {
        this.uploads--;
      }
      return true;
    }
    const publication = /^\/v1\/artifacts\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(path);
    if (publication && request.method === "PUT" && this.queue.get(publication[1])) {
      const input = decode(
        ArtifactWrite,
        JSON.parse((await readBody(request, MAX_METADATA_BYTES)).toString()),
      );
      checkPairing();
      this.reply(response, 202, this.queue.put(publication[1], input));
      return true;
    }
    return false;
  }
}
