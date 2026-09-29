import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";

const nonfatalKeysymWarnings =
  /The XKEYBOARD keymap compiler \(xkbcomp\) reports:\r?\n(?:> Warning:[ \t]+Could not resolve keysym XF86[A-Za-z0-9_]+\r?\n)+Errors from xkbcomp are not fatal to the X server\r?\n/g;
const eglPermissionWarning =
  /^libEGL warning: failed to open \/dev\/dri\/card0: Permission denied\r?\n(?:\r?\n)?/gm;

export async function testDisplay() {
  const diagnostics: Buffer[] = [];
  const server = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1440x900x24", "-nolisten", "tcp"],
    { stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  server.stderr!.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  async function close(succeeded = true) {
    server.kill();
    await closed;
    if (!succeeded) {
      let warningReports = 0;
      let eglWarnings = 0;
      const output = Buffer.concat(diagnostics)
        .toString()
        .replace(nonfatalKeysymWarnings, () => {
          warningReports++;
          return "";
        })
        .replace(eglPermissionWarning, (warning) => {
          eglWarnings++;
          return eglWarnings === 1 ? warning : "";
        });
      if (output) process.stderr.write(output);
      if (warningReports)
        process.stderr.write(
          `Xvfb: omitted ${warningReports} nonfatal XF86 keysym warning reports.\n`,
        );
      if (eglWarnings > 1)
        process.stderr.write(
          `Xvfb: repeated the libEGL permission warning ${eglWarnings} times.\n`,
        );
    }
  }
  try {
    const output = server.stdio[3] as Readable;
    const [number] = await Promise.race([
      once(output, "data"),
      once(server, "exit").then(([code, signal]) => {
        throw new Error(`Xvfb exited before providing a display: ${signal ?? code}`);
      }),
    ]);
    return { display: `:${String(number).trim()}`, close };
  } catch (error) {
    await close(false);
    throw error;
  }
}
