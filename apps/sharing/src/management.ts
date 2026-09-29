import { createServer, type IncomingMessage } from "node:http";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { MAX_SHARE_REQUEST_BYTES, ShareWrite } from "@irudd-scope/protocol/sharing";
import { SharingError, SharingService, json } from "./service.ts";

async function readBody(request: IncomingMessage, limit: number) {
  if (request.headers["content-type"] !== "application/json")
    throw new SharingError(415, "Expected JSON.");
  if (Number(request.headers["content-length"]) > limit)
    throw new SharingError(413, "Request too large.");
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new SharingError(413, "Request too large.");
    buffers.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString("utf8"));
  } catch {
    throw new SharingError(400, "Invalid JSON.");
  }
}

export async function startManagement(service: SharingService, port = 0, host = "127.0.0.1") {
  let reading = false;
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 60_000, headersTimeout: 5000 },
    (request, response) => {
      void (async () => {
        if (request.headers.origin)
          throw new SharingError(403, "Browser requests are not allowed.");
        const token = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
        if (!token) throw new SharingError(401, "Authentication required.");
        if (request.method === "POST" && request.url === "/v1/pair") {
          const name = decode(
            Schema.Struct({
              name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
            }),
            await readBody(request, 4096),
          ).name;
          try {
            json(response, 200, service.store.pair(token, name, Date.now()));
          } catch {
            throw new SharingError(
              401,
              "Pairing expired or was already used. Generate a fresh pairing URL.",
            );
          }
          return;
        }
        if (!service.store.authorized(token)) {
          if (
            request.method === "DELETE" &&
            request.url === "/v1/pair" &&
            service.store.revoked(token)
          ) {
            json(response, 200, { removed: true });
            return;
          }
          throw new SharingError(401, "Pairing credential was revoked.");
        }
        if (request.method === "GET" && request.url === "/v1/shares") {
          json(response, 200, service.status());
          return;
        }
        if (request.method === "DELETE" && request.url === "/v1/pair") {
          await service.unpair();
          json(response, 200, { removed: true });
          return;
        }
        const match = /^\/v1\/shares\/([a-f0-9-]{36})$/.exec(request.url ?? "");
        if (!match) throw new SharingError(404, "Not found.");
        if (request.method === "DELETE") {
          await service.stop(match[1]);
          json(response, 200, { stopped: true });
          return;
        }
        if (request.method !== "PUT") throw new SharingError(405, "Method not allowed.");
        if (reading)
          throw new SharingError(409, "Another snapshot is being received. Retry shortly.");
        reading = true;
        try {
          let input;
          try {
            input = decode(ShareWrite, await readBody(request, MAX_SHARE_REQUEST_BYTES));
          } catch (error) {
            if (error instanceof SharingError) throw error;
            throw new SharingError(400, "Invalid share request.");
          }
          // Pairing can be revoked while an upload is arriving.
          if (!service.store.authorized(token))
            throw new SharingError(401, "Pairing credential was revoked.");
          json(response, 200, await service.write(match[1], input));
        } finally {
          reading = false;
        }
      })().catch((error) => {
        if (!response.headersSent)
          json(response, error instanceof SharingError ? error.status : 400, {
            error: error instanceof SharingError ? error.message : "Invalid request.",
          });
        else response.destroy();
      });
    },
  );
  server.maxConnections = 16;
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("checkContinue", (_req, res) => res.writeHead(417, { Connection: "close" }).end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
