import { createRequire, register, syncBuiltinESMExports } from "node:module";
import type { SpawnOptions } from "node:child_process";
const childProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");
const spawn = childProcess.spawn;
// argv[0] survives parent death, including the interval before an Electron launch resolves.
childProcess.spawn = ((
  command: string,
  args: string[] | SpawnOptions = [],
  options: SpawnOptions = {},
) => {
  const argv = Array.isArray(args) ? args : [];
  const opts = Array.isArray(args) ? options : args;
  const child = spawn(command, argv, { ...opts, argv0: process.env.SCOPE_PERFORMANCE_MARKER });
  if (child.pid) process.send?.({ type: "owned-child", pid: child.pid, detached: !!opts.detached });
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
// Existing fixtures import TypeScript parameter properties, beyond Node's type stripping.
register("./typescript-loader.ts", import.meta.url);
await import("./worker.ts");
