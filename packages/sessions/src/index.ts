import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionDays, SessionsReply } from "./contract.ts";

export { runSessionsReaderProcess } from "./reader-process.ts";
export type * from "./contract.ts";

/** The reader entry beside the bundle that runs this code, or this package's source. */
function readerEntry() {
  const bundled = join(import.meta.dirname, "sessions-reader.mjs");
  return existsSync(bundled) ? bundled : join(import.meta.dirname, "reader-entry.ts");
}

/**
 * Reads this computer's agent sessions in a separate process and resolves with its reply.
 * The process exits after replying; aborting the signal stops it.
 */
export function readSessionsInProcess(options: {
  home: string;
  days: SessionDays;
  signal?: AbortSignal;
}): Promise<SessionsReply> {
  return new Promise((resolve, reject) => {
    const child = fork(readerEntry(), [], {
      execArgv: [],
      // Electron runs the entry as plain Node; Node ignores the variable.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
    });
    let settled = false;
    const settle = (error: Error | null, reply?: SessionsReply) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve(reply!);
    };
    const stop = () => {
      child.kill();
      settle(new Error("The read was stopped."));
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("message", (message: { reply?: SessionsReply; error?: string }) =>
      message.reply ? settle(null, message.reply) : settle(new Error(message.error)),
    );
    child.once("exit", () =>
      settle(new Error("Scope could not read this computer's agent sessions.")),
    );
    child.once("error", () =>
      settle(new Error("Scope could not read this computer's agent sessions.")),
    );
    child.send({ home: options.home, days: options.days });
  });
}
