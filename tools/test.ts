import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";

// Resolve Electron once so parallel test workers cannot race its lazy installation.
createRequire(new URL("../apps/desktop/package.json", import.meta.url))("electron");

let displayServer: ReturnType<typeof spawn> | undefined;
let displayClosed: Promise<void> | undefined;
let succeeded = false;
const displayDiagnostics: Buffer[] = [];
try {
  const environment: NodeJS.ProcessEnv = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  if (process.platform === "linux" && !environment.DISPLAY) {
    displayServer = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    displayClosed = new Promise((resolve) => displayServer!.once("close", () => resolve()));
    displayServer.stderr!.on("data", (chunk: Buffer) => displayDiagnostics.push(chunk));
    const output = displayServer.stdio[3] as Readable;
    const [number] = await Promise.race([
      once(output, "data"),
      once(displayServer, "exit").then(([code, signal]) => {
        throw new Error(`Xvfb exited before providing a display: ${signal ?? code}`);
      }),
    ]);
    environment.DISPLAY = `:${String(number).trim()}`;
  }
  const tests = spawn("vp", ["test", "run", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: environment,
  });
  const [code] = await once(tests, "exit");
  process.exitCode = typeof code === "number" ? code : 1;
  succeeded = code === 0;
} finally {
  displayServer?.kill();
  await displayClosed;
  if (!succeeded) process.stderr.write(Buffer.concat(displayDiagnostics));
}
