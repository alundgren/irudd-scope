import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { scanMachine } from "@irudd-scope/harnesses";
import type { HarnessScan, HarnessesReply } from "@irudd-scope/protocol/harnesses";
import type { HarnessScanStore } from "./harness-scans.ts";

/**
 * Scans this computer's harnesses at startup and on request, and keeps the latest scan in
 * desktop.db. A scan answers once every fact except folder sizes is known; sizes are counted
 * afterwards and saved when they finish. There is no periodic scan.
 */
export class HarnessesService {
  private latest: HarnessScan | null = null;
  private running: Promise<HarnessScan> | null = null;
  private sizes: { controller: AbortController; done: Promise<void> } | null = null;
  private readonly closing = new AbortController();

  constructor(
    private readonly store: HarnessScanStore,
    private readonly home = homedir(),
    private readonly path = harnessPath(),
  ) {}

  async start(): Promise<void> {
    this.latest = await this.store.read("local");
    void this.scan().catch(() => console.error("Scope could not scan harnesses."));
  }

  async read(): Promise<HarnessesReply> {
    if (!this.latest && this.running) await this.running.catch(() => {});
    return { machines: this.latest ? [this.latest] : [] };
  }

  /** Concurrent requests share one scan. A new scan replaces a size count still running. */
  scan(): Promise<HarnessScan> {
    if (this.closing.signal.aborted) return Promise.reject(new Error("Scope is closing."));
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async close(): Promise<void> {
    this.closing.abort();
    this.sizes?.controller.abort();
    await this.running?.catch(() => {});
    await this.sizes?.done;
  }

  /** The scanner validates each scan, so an invalid scan never replaces the latest one. */
  private async run(): Promise<HarnessScan> {
    const run = await scanMachine({
      home: this.home,
      path: this.path,
      signal: this.closing.signal,
    });
    this.sizes?.controller.abort();
    await this.sizes?.done;
    this.latest = run.scan;
    await this.save(run.scan);
    if (this.closing.signal.aborted) return run.scan;
    const controller = new AbortController();
    const sizes = {
      controller,
      done: run
        .sizes(controller.signal)
        .then(async (scan) => {
          if (controller.signal.aborted) return;
          this.latest = scan;
          await this.save(scan);
        })
        .catch(() => {
          if (!controller.signal.aborted) console.error("Scope could not count harness folders.");
        })
        .finally(() => {
          if (this.sizes === sizes) this.sizes = null;
        }),
    };
    this.sizes = sizes;
    return run.scan;
  }

  private async save(scan: HarnessScan): Promise<void> {
    if (!(await this.store.save(scan)))
      console.error("The harness scan exceeds 256 KiB and was not saved.");
  }
}

/** GUI launches on macOS omit the package-manager and per-user directories. */
function harnessPath(): string {
  const key =
    process.platform === "win32"
      ? (Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH")
      : "PATH";
  return [
    process.env[key] ?? "",
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] : []),
    join(homedir(), ".local", "bin"),
  ]
    .filter(Boolean)
    .join(delimiter);
}
