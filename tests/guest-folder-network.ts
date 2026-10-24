import { createServer, request as httpRequest } from "node:http";
import { GUEST_FOLDER_HEADER } from "@irudd-scope/protocol/guest-folder";

/** Streaming fault proxy. Pair receipts remain only in test memory across synthetic restarts. */
export async function folderNetwork() {
  let port = 0;
  let authorization = "";
  let pairReceipt: Buffer | undefined;
  let old = false,
    drop = false;
  let largestBuffer = 0;
  let pauseUpload = 0;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/v1/relay/folders/capabilities") && old) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/v1/pair" && pairReceipt) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(pairReceipt);
      return;
    }
    if (request.headers.authorization && request.url?.startsWith("/guest/"))
      authorization = request.headers.authorization;
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        if (
          drop &&
          request.url?.startsWith("/v1/relay/folders/operations") &&
          incoming.statusCode === 200
        ) {
          drop = false;
          incoming.resume();
          incoming.once("end", () => response.destroy());
          return;
        }
        if (request.url === "/v1/pair" && incoming.statusCode === 200) {
          const parts: Buffer[] = [];
          incoming.on("data", (part) => parts.push(part));
          incoming.once("end", () => {
            pairReceipt = Buffer.concat(parts);
            response.writeHead(200, incoming.headers).end(pairReceipt);
          });
          return;
        }
        response.writeHead(incoming.statusCode!, incoming.headers);
        incoming.pipe(response);
        incoming.on("error", () => response.destroy());
      },
    );
    request.on("data", () => {
      largestBuffer = Math.max(largestBuffer, upstream.writableLength, response.writableLength);
    });
    if (pauseUpload && request.url?.startsWith("/v1/relay/folders/operations")) {
      const duration = pauseUpload;
      pauseUpload = 0;
      request.pause();
      const timer = setTimeout(() => request.pipe(upstream), duration);
      response.once("close", () => clearTimeout(timer));
    } else request.pipe(upstream);
    upstream.on("error", () => response.destroy());
    response.once("close", () => upstream.destroy());
  });
  server.requestTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const proxyPort = (server.address() as { port: number }).port;
  return {
    port: proxyPort,
    target(value: number) {
      port = value;
    },
    old(value: boolean) {
      old = value;
    },
    drop() {
      drop = true;
    },
    largestBuffer: () => largestBuffer,
    pauseNextUpload(ms: number) {
      pauseUpload = ms;
    },
    pairUrl(value: string) {
      const url = new URL(value);
      url.searchParams.set("endpoint", `http://127.0.0.1:${proxyPort}`);
      return url.toString();
    },
    async call(route: string, metadata: unknown, body = Buffer.alloc(0), gap = 0, cancel = 0) {
      const started = Date.now();
      return await new Promise<{ status: number; value: any; elapsed: number }>(
        (resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let cancellation: ReturnType<typeof setTimeout> | undefined;
          const request = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path: `/guest/folder-${route}`,
              method: route === "upload" ? "PUT" : "POST",
              headers: {
                Authorization: authorization,
                [GUEST_FOLDER_HEADER]: Buffer.from(JSON.stringify(metadata)).toString("base64url"),
              },
            },
            (response) => {
              const parts: Buffer[] = [];
              response.on("data", (part) => parts.push(part));
              response.once("end", () =>
                resolve({
                  status: response.statusCode!,
                  value: JSON.parse(Buffer.concat(parts).toString()),
                  elapsed: Date.now() - started,
                }),
              );
              response.on("error", reject);
            },
          );
          request.on("error", (error) =>
            resolve({ status: 0, value: { error: error.message }, elapsed: Date.now() - started }),
          );
          request.once("close", () => {
            clearTimeout(timer);
            clearTimeout(cancellation);
          });
          if (gap) {
            request.write(body.subarray(0, 1));
            timer = setTimeout(() => request.end(body.subarray(1)), gap);
          } else request.end(body);
          if (cancel)
            cancellation = setTimeout(
              () => request.destroy(new Error("Synthetic cancellation")),
              cancel,
            );
        },
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
