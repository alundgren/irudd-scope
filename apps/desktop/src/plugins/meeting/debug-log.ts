import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

// Prototype only. The Meeting canvas test build keeps this log so its prompt and models can be
// tuned from real meetings. Remove it with the test build. Callers never pass audio or keys.

const MAX_BYTES = 5 * 1024 * 1024;

export function meetingDebugLog(directory: string) {
  const file = join(directory, "meeting-canvas-debug.jsonl");
  let pending = Promise.resolve();
  async function write(line: string) {
    const size = await stat(file).then(
      (info) => info.size,
      () => 0,
    );
    if (size + line.length > MAX_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, line, { mode: 0o600 });
  }
  return {
    file,
    write(entry: Record<string, unknown>) {
      const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
      pending = pending.then(() => write(line)).catch(() => {});
    },
    flush: () => pending,
  };
}
