import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { testDisplay } from "./test-display.ts";

// Resolve Electron once so parallel test workers cannot race its lazy installation.
createRequire(new URL("../apps/desktop/package.json", import.meta.url))("electron");

let display: Awaited<ReturnType<typeof testDisplay>> | undefined;
let succeeded = false;
try {
  const environment: NodeJS.ProcessEnv = { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1" };
  if (process.platform === "linux" && !environment.DISPLAY) {
    display = await testDisplay();
    environment.DISPLAY = display.display;
  }
  const tests = spawn("vp", ["test", "run", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: environment,
  });
  const [code] = await once(tests, "exit");
  process.exitCode = typeof code === "number" ? code : 1;
  succeeded = code === 0;
} finally {
  await display?.close(succeeded);
}
