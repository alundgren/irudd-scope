import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

/** Changes only synthetic peer responses; real app authentication and storage still execute. */
export async function guestResponseFixture() {
  let ownerPort = 0;
  let authorization = "";
  let dropMutation = false;
  let omitted: { secret: string; capabilities: string[] } | undefined;
  let mode: "normal" | "unsupported" | "partial" | "stale" | "same-revision" | "unknown-kind" =
    "normal";
  let savedCatalog = "";
  let latestCatalog = "";
  let holdContent = false;
  let pauseContent = false;
  let waiting: (() => void) | undefined;
  let catalogRequests = 0;
  let heldReads = 0;
  let contentReads = 0;
  let failContent = false;
  let offline = false;
  let denied = false;
  const server = createServer((request, response) => {
    if (request.url === "/resource.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end("document.body.dataset.externalResource = 'loaded';");
      return;
    }
    if (denied) {
      response
        .writeHead(403, { "Content-Type": "application/json" })
        .end('{"error":"Guest access rejected."}');
      return;
    }
    if (offline) {
      response.destroy();
      return;
    }
    if (request.headers.authorization) authorization = request.headers.authorization;
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: ownerPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        if (
          request.url === "/guest/mutation-execute" &&
          dropMutation &&
          incoming.statusCode === 200
        ) {
          dropMutation = false;
          incoming.resume();
          incoming.on("end", () => response.destroy());
          return;
        }
        if (request.url === "/guest/hello" && omitted && incoming.statusCode === 200) {
          const parts: Buffer[] = [];
          incoming.on("data", (part) => parts.push(part));
          incoming.on("end", () => {
            const { mac: _mac, ...reply } = JSON.parse(Buffer.concat(parts).toString());
            reply.hello.capabilities = reply.hello.capabilities.filter(
              (capability: string) => !omitted!.capabilities.includes(capability),
            );
            const mac = createHmac("sha256", Buffer.from(omitted!.secret, "base64url"))
              .update("scope-guest:reply:" + JSON.stringify(reply))
              .digest("base64url");
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ...reply, mac }));
          });
          incoming.on("error", () => response.destroy());
          return;
        }
        const catalog = request.url === "/guest/catalog" && incoming.statusCode === 200;
        const content = request.url === "/guest/artifact-content" && incoming.statusCode === 200;
        if (content) {
          contentReads++;
          if (failContent) {
            failContent = false;
            incoming.resume();
            response.destroy();
            return;
          }
        }
        if (!catalog && !(content && holdContent)) {
          response.writeHead(incoming.statusCode!, incoming.headers);
          incoming.pipe(response);
          return;
        }
        if (content && pauseContent) {
          heldReads++;
          incoming.pause();
          response.writeHead(incoming.statusCode!, incoming.headers);
          incoming.on("aborted", () => response.destroy());
          incoming.on("error", () => response.destroy());
          waiting = () => {
            incoming.pipe(response);
          };
          return;
        }
        const parts: Buffer[] = [];
        incoming.on("data", (part) => parts.push(part));
        incoming.on("end", () => {
          const body = Buffer.concat(parts);
          if (content) {
            heldReads++;
            waiting = () => {
              response.writeHead(incoming.statusCode!, incoming.headers);
              response.end(body);
            };
            return;
          }
          catalogRequests++;
          const original = body.toString();
          if (mode === "normal") latestCatalog = original;
          if (!savedCatalog) savedCatalog = original;
          if (mode === "partial") {
            response.writeHead(200, {
              "Content-Type": "application/json",
              "Content-Length": body.length + 100,
            });
            response.write(body.subarray(0, 20));
            response.destroy();
          } else {
            const document = JSON.parse(
              mode === "stale" ? savedCatalog : mode === "same-revision" ? latestCatalog : original,
            );
            if (mode === "same-revision") document.sources[0].title = "Changed without a revision";
            if (mode === "unsupported") document.sources[0].version = 999;
            if (mode === "unknown-kind") document.sources[0].kind = "future-tool";
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(document));
          }
        });
        incoming.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
    response.once("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    omitCapabilities(secret: string, capabilities: string[]) {
      omitted = capabilities.length ? { secret, capabilities } : undefined;
    },
    dropNextMutationReply() {
      dropMutation = true;
    },
    async peer(route: string, body: unknown) {
      const response = await fetch(`http://127.0.0.1:${ownerPort}/guest/${route}`, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    denyAccess(value: boolean) {
      denied = value;
      if (value) server.closeAllConnections();
    },
    offline(value: boolean) {
      offline = value;
      if (value) server.closeAllConnections();
    },
    target(port: number) {
      ownerPort = port;
    },
    mode(value: typeof mode) {
      mode = value;
    },
    hold() {
      holdContent = true;
    },
    pause() {
      holdContent = true;
      pauseContent = true;
    },
    held() {
      return heldReads;
    },
    requests() {
      return catalogRequests;
    },
    failNextContent() {
      failContent = true;
    },
    reads() {
      return contentReads;
    },
    release() {
      holdContent = false;
      pauseContent = false;
      waiting?.();
      waiting = undefined;
    },
    async close() {
      waiting = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
