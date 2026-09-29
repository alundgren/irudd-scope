import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";

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
    if (!succeeded) process.stderr.write(Buffer.concat(diagnostics));
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
