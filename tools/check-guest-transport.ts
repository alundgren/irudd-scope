import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { GuestNetwork } from "../apps/desktop/src/guest/tailscale.ts";

// Opt-in native listener check. Never changes Tailscale configuration.
const network = new GuestNetwork();
const proof = randomBytes(32).toString("base64url");
const server = createServer((request, response) =>
  response
    .writeHead(
      request.url === "/guest/identity" && request.headers.authorization === "Bearer " + proof
        ? 200
        : 403,
    )
    .end(),
);
try {
  const { address } = await network.discover(AbortSignal.timeout(10000));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, resolve);
  });
  const port = (server.address() as { port: number }).port;
  for (const [token, expected] of [
    [proof, 200],
    ["invalid", 403],
  ] as const) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const pending = request(
        {
          host: address,
          port,
          localAddress: address,
          path: "/guest/identity",
          signal: AbortSignal.timeout(5000),
          headers: { Authorization: "Bearer " + token },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
          response.once("error", reject);
        },
      );
      pending.once("error", reject);
      pending.end();
    });
    if (status !== expected) throw new Error("Guest listener authentication failed.");
  }
  console.log(
    "PASS: installed Tailscale discovery, exact local IPv4 binding and authenticated HTTP. Peer connectivity and native credential storage require separate checks.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Guest transport check failed.");
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
