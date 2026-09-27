import { spawn } from "node:child_process";
import { stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { decode } from "@irudd-scope/protocol";
import {
  DatabaseShrink,
  MAINTENANCE_TIMEOUT_MS,
  type DatabaseBytes,
} from "@irudd-scope/protocol/maintenance";

export const SHRINK_THRESHOLD = 100_000_000;
export const SHRINK_INTERVAL_MS = 24 * 60 * 60_000;
export const MAINTENANCE_POLL_MS = 60_000;

export async function databaseBytes(filename: string): Promise<DatabaseBytes> {
  const info = async (path: string) =>
    stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
  const [main, wal] = await Promise.all([info(filename), info(`${filename}-wal`)]);
  return {
    main: main?.size ?? 0,
    wal: wal?.size ?? 0,
    allocated: ((main?.blocks ?? 0) + (wal?.blocks ?? 0)) * 512,
  };
}

export function shrinkDue(bytes: DatabaseBytes, lastSuccess: string | null, now: number): boolean {
  return (
    bytes.main + bytes.wal > SHRINK_THRESHOLD &&
    (lastSuccess === null || now - Date.parse(lastSuccess) >= SHRINK_INTERVAL_MS)
  );
}

// A separate process keeps SQLite's blocking work out of Electron and relay heartbeats.
const vacuumProgram = String.raw`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec('PRAGMA busy_timeout = 500;');
  const checkpoint = () => { if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw new Error('busy'); };
  checkpoint();
  db.exec('VACUUM');
  checkpoint();
  console.log(JSON.stringify({ status: 'completed' }));
} catch (error) {
  const busy = /busy|locked/i.test(error.message);
  console.log(JSON.stringify({ status: busy ? 'deferred' : 'failed', reason: busy ? 'Database is busy. Retry when current operations finish.' : 'SQLite could not shrink the database.' }));
} finally { db.close(); }
`;

export class DatabaseMaintenance {
  private active?: Promise<DatabaseShrink>;
  private barrier?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private lastSuccess: string | null;
  private lastReceipt: DatabaseShrink | null;

  constructor(
    private readonly filename: string,
    private readonly database: DatabaseShrink["database"],
    private readonly cleanup: () => Promise<number> = async () => 0,
    private readonly clock: () => number = Date.now,
    private readonly measure: () => Promise<DatabaseBytes> = () => databaseBytes(filename),
    private readonly availableSpace: () => Promise<number> = async () => {
      const spaces = await Promise.all([statfs(dirname(filename)), statfs(tmpdir())]);
      return Math.min(...spaces.map((space) => space.bavail * space.bsize));
    },
  ) {
    const db = new DatabaseSync(filename);
    try {
      db.exec(
        "PRAGMA busy_timeout = 50; CREATE TABLE IF NOT EXISTS maintenance (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
      );
      this.lastSuccess =
        (db.prepare("SELECT value FROM maintenance WHERE name = 'last_success'").get()
          ?.value as string) ?? null;
      const receipt = db
        .prepare("SELECT value FROM maintenance WHERE name = 'last_receipt'")
        .get()?.value;
      this.lastReceipt = receipt ? decode(DatabaseShrink, JSON.parse(String(receipt))) : null;
    } finally {
      db.close();
    }
  }

  async idle(): Promise<void> {
    await this.barrier;
  }
  latest(): DatabaseShrink | null {
    return this.lastReceipt;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, MAINTENANCE_POLL_MS);
    this.timer.unref();
    void this.check();
  }
  async check(): Promise<void> {
    if (this.active || this.controller.signal.aborted) return;
    await this.run(false).catch(() => {
      console.error(`Could not maintain ${this.database}. Retrying on the next check.`);
    });
  }

  async run(manual = true, timeoutMs = MAINTENANCE_TIMEOUT_MS): Promise<DatabaseShrink> {
    if (this.active) {
      const bytes = await this.measure();
      return {
        database: this.database,
        before: bytes,
        after: bytes,
        durationMs: 0,
        status: "deferred",
        lastSuccess: this.lastSuccess,
        reason: "A shrink is already running. Read maintenance status for its result.",
      };
    }
    const task = this.perform(manual, timeoutMs);
    this.active = task;
    try {
      return await task;
    } finally {
      this.active = undefined;
    }
  }

  private async perform(manual: boolean, timeoutMs: number): Promise<DatabaseShrink> {
    const started = this.clock();
    const deadline = Date.now() + timeoutMs;
    const before = await this.measure();
    const receipt: { -readonly [K in keyof DatabaseShrink]: DatabaseShrink[K] } = {
      database: this.database,
      before,
      after: before,
      durationMs: 0,
      status: "skipped",
      lastSuccess: this.lastSuccess,
    };
    let release: (() => void) | undefined;
    try {
      try {
        const deferredBytes = await this.cleanup();
        if (!manual && !shrinkDue(before, this.lastSuccess, started)) {
          return {
            ...receipt,
            reason:
              before.main + before.wal <= SHRINK_THRESHOLD
                ? "Database is at or below 100 MB."
                : "Last successful shrink was less than 24 hours ago.",
            deferredBytes,
          };
        }
        this.barrier = new Promise<void>((done) => {
          release = done;
        });
        if ((await this.availableSpace()) < 2 * (before.main + before.wal) + 1_048_576) {
          receipt.status = "deferred";
          receipt.reason = "Insufficient temporary disk space. Free space and retry.";
        } else if (Date.now() >= deadline || this.controller.signal.aborted) {
          receipt.status = "deferred";
          receipt.reason = "Maintenance deadline reached before shrinking.";
        } else {
          const result = await this.vacuum(Math.max(1, deadline - Date.now()));
          receipt.status = result.status;
          if (result.reason) receipt.reason = result.reason;
        }
        receipt.deferredBytes = deferredBytes;
        if (receipt.status === "completed" && deferredBytes)
          receipt.reason =
            "Uploaded content is still within the 15-minute staging period; unused bytes will be reclaimed after expiry.";
        if (receipt.status === "completed") {
          receipt.lastSuccess = new Date(this.clock()).toISOString();
        }
      } catch {
        receipt.status = "failed";
        receipt.reason = "Database cleanup or shrinking failed. Retry maintenance.";
      }
      let db: DatabaseSync | undefined;
      try {
        receipt.after = await this.measure();
        receipt.durationMs = Math.max(0, this.clock() - started);
        db = new DatabaseSync(this.filename);
        db.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE");
        const save = db.prepare(
          "INSERT INTO maintenance VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        );
        try {
          if (receipt.lastSuccess) save.run("last_success", receipt.lastSuccess);
          save.run("last_receipt", JSON.stringify(decode(DatabaseShrink, receipt)));
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        this.lastSuccess = receipt.lastSuccess;
      } catch {
        if (receipt.status === "completed") {
          receipt.status = "failed";
          receipt.reason = "Could not save the maintenance result. Retry maintenance.";
        }
        receipt.lastSuccess = this.lastSuccess;
      } finally {
        db?.close();
      }
      // VACUUM and its checkpoints finished before the small receipt transaction.
      receipt.after = await this.measure().catch(() => receipt.after);
      receipt.durationMs = Math.max(0, this.clock() - started);
      this.lastReceipt = decode(DatabaseShrink, receipt);
      return this.lastReceipt;
    } finally {
      release?.();
      this.barrier = undefined;
    }
  }

  private vacuum(
    timeoutMs: number,
  ): Promise<{ status: DatabaseShrink["status"]; reason?: string }> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--input-type=commonjs", "-e", vacuumProgram, this.filename],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let output = "";
      let stopped = false;
      const stop = () => {
        stopped = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, timeoutMs);
      this.controller.signal.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 4096) stop();
      });
      child.once("error", () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", stop);
        resolve({ status: "failed", reason: "Could not start SQLite maintenance." });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", stop);
        if (stopped) {
          resolve({
            status: "deferred",
            reason:
              "Shrink was interrupted or exceeded its deadline. Check maintenance status and retry.",
          });
          return;
        }
        try {
          const result = JSON.parse(output);
          if (code !== 0 || !["completed", "deferred", "failed"].includes(result.status))
            throw new Error();
          resolve(result);
        } catch {
          resolve({ status: "failed", reason: "SQLite maintenance did not finish." });
        }
      });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await this.active;
  }
}
