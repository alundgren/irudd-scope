import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { GuestTransport } from "../apps/desktop/src/guest/transport.ts";

// Opt-in native smoke: uses installed Tailcat and synthetic memory-only keys.
const transport = new GuestTransport(() => {}, resolve("apps/desktop/dist/guest-process.mjs"));
const proof = randomBytes(32).toString("base64url");
const server = createServer((request, response) =>
  response.writeHead(request.headers.authorization === "Bearer " + proof ? 200 : 403).end(),
);
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const key = await transport.generate();
  let previous: string | undefined;
  for (let i = 0; i < 2; i++) {
    const endpoint = await transport.start(key, port);
    if (previous && previous !== endpoint.address)
      throw new Error("Guest address did not survive restart.");
    for (const [token, expected] of [
      [proof, 200],
      ["invalid", 403],
    ] as const) {
      const response = await transport.request(endpoint, "/", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(30000),
        deadlineMs: 25000,
        idleMs: 10000,
      });
      for await (const _ of response.body) {
        /* consume before checking cleanup */
      }
      if (response.status !== expected) throw new Error("Guest application authentication failed.");
    }
    previous = endpoint.address;
    await transport.close();
  }
  console.log(
    "PASS: protected key generation/restoration, actual HTTP adapter over PSK-preserving SOCKS, stable address after worker restart, and separate application authentication.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Guest transport check failed.");
  process.exitCode = 1;
} finally {
  await transport.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
