import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { timingSafeEqual } from "node:crypto";
import { DEFAULT_PORT, validateEndpoint } from "@irudd-scope/protocol";

export async function startHub(options: { endpoint: string; token: string; port?: number }) {
  const endpoint = validateEndpoint(options.endpoint);
  if (options.token.length < 24 || /[\r\n]/.test(options.token))
    throw new Error(
      "Use the desktop publishing token with at least 24 characters and no newlines.",
    );
  const forward = endpoint.startsWith("https:") ? httpsRequest : httpRequest;
  const expected = Buffer.from(`Bearer ${options.token}`);
  const active = new Set<ClientRequest>();
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const json = (status: number, error: string) => {
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify({ error }));
      };
      const received = Buffer.from(request.headers.authorization ?? "");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        json(401, "A valid publishing token is required.");
        return;
      }
      if (request.headers.origin) {
        json(403, "Browser-origin requests are not supported.");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        json(400, "Invalid request URL.");
        return;
      }
      if (!url.pathname.startsWith("/v1/")) {
        json(404, "Endpoint not found.");
        return;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${options.token}` };
      for (const name of ["content-type", "content-length"] as const) {
        const value = request.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      const unavailable = () =>
        json(503, "Scope on the Mac is unavailable. Open it and retry. Requests are not queued.");
      const upstream = forward(
        `${endpoint}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.on("error", unavailable);
          incoming.pipe(response);
        },
      );
      active.add(upstream);
      upstream.on("close", () => active.delete(upstream));
      upstream.on("error", unavailable);
      upstream.setTimeout(30_000, () => upstream.destroy(new Error("Desktop request timed out.")));
      response.on("close", () => upstream.destroy());
      request.on("error", () => upstream.destroy());
      request.pipe(upstream);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The hub has no TCP address.");
  const target = new URL(endpoint);
  if (
    ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) &&
    Number(target.port) === address.port
  ) {
    server.close();
    throw new Error("The hub must forward to the desktop, not its own port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const request of active) request.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
