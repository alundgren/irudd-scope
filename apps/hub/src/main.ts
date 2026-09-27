import { homedir } from "node:os";
import { join } from "node:path";
import { startHub } from "./server.ts";

const hub = await startHub({
  directory: process.env.SCOPE_DATA_DIR ?? join(homedir(), ".local", "share", "irudd-scope"),
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
