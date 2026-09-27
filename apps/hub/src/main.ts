import { startHub } from "./server.ts";

if (!process.env.SCOPE_ENDPOINT)
  throw new Error("Set SCOPE_ENDPOINT to the Mac's private HTTPS publishing endpoint.");

const hub = await startHub({
  endpoint: process.env.SCOPE_ENDPOINT,
  token: process.env.SCOPE_TOKEN ?? "",
  port: process.env.SCOPE_PORT ? Number(process.env.SCOPE_PORT) : undefined,
});
console.log(`Scope hub listening on ${hub.url}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void hub.close().then(() => {
      process.exitCode = 0;
    });
  });
