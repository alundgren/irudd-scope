import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";

let displayServer: ReturnType<typeof spawn> | undefined;
try {
  const environment: NodeJS.ProcessEnv = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  if (process.platform === "linux" && !environment.DISPLAY) {
    displayServer = spawn(
      "Xvfb",
      ["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
      { stdio: ["ignore", "ignore", "inherit", "pipe"] },
    );
    const output = displayServer.stdio[3] as Readable;
    const [number] = await Promise.race([
      once(output, "data"),
      once(displayServer, "error").then(([error]) => {
        throw error;
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
} finally {
  displayServer?.kill();
}
