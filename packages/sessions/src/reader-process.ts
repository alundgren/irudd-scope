import { readSessions, SessionsReadError } from "./read.ts";
import type { SessionDays } from "./contract.ts";

type Request = { home: string; days: SessionDays };

/**
 * The reader process: reads one request from its parent, replies once and exits. SQLite reads
 * block, so they never run in Electron's main process.
 */
export function runSessionsReaderProcess() {
  process.once("message", (request: Request) => {
    readSessions(request).then(
      (reply) => process.send!({ reply }, () => process.exit(0)),
      (error: unknown) =>
        process.send!(
          {
            error:
              error instanceof SessionsReadError
                ? error.message
                : "Scope could not read this computer's agent sessions.",
          },
          () => process.exit(0),
        ),
    );
  });
}
