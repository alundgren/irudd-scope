import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { readHarnessFile, scanMachine } from "@irudd-scope/harnesses";
import type {
  HarnessFileReply,
  HarnessFileRequest,
  HarnessMachine,
  HarnessScan,
  HarnessesReply,
} from "@irudd-scope/protocol/harnesses";
import type { HarnessScanStore } from "./harness-scans.ts";
import type { HarnessesState } from "./plugins/harnesses/contract.ts";

const SCAN_FAILED = "Scope could not scan this computer's harnesses.";

/**
 * Scans this computer's harnesses at startup and on request, and keeps the latest scan in
 * desktop.db. A scan answers once every fact except folder sizes is known; sizes are counted
 * afterwards and saved when they finish. There is no periodic scan. `onChange` reports each
 * started, finished or failed scan and each finished size count.
 */
export class HarnessesService {
  private latest: HarnessScan | null = null;
  private running: Promise<HarnessScan> | null = null;
  private sizes: { controller: AbortController; done: Promise<void> } | null = null;
  private error: string | null = null;
  private readonly closing = new AbortController();

  constructor(
    private readonly store: HarnessScanStore,
    private readonly onChange: (state: HarnessesState) => void = () => {},
    private readonly home = homedir(),
    private readonly path = harnessPath(),
  ) {}

  async start(): Promise<void> {
    this.latest = await this.store.read("local");
    void this.scan().catch(() => console.error("Scope could not scan harnesses."));
  }

  async read(): Promise<HarnessesReply> {
    if (!this.latest && this.running) await this.running.catch(() => {});
    return this.reply();
  }

  /** Answers at once, without waiting for a running scan. */
  state(): HarnessesState {
    return {
      reply: this.reply(),
      scanning: this.running !== null,
      error: this.error,
    };
  }

  /** The latest scan of one machine. This desktop scans only its own computer. */
  latestScan(machine: HarnessMachine): HarnessScan | null {
    return machine === "local" ? this.latest : null;
  }

  /**
   * Reads one instruction file or SKILL.md that the latest scan lists. The text is returned
   * only to the caller; it is never saved or logged.
   */
  async file(request: HarnessFileRequest): Promise<HarnessFileReply> {
    if (!this.latest && this.running) await this.running.catch(() => {});
    return readHarnessFile({
      home: this.home,
      scan: this.latestScan(request.machine),
      harness: request.harness,
      path: request.path,
    });
  }

  /** Concurrent requests share one scan. A new scan replaces a size count still running. */
  scan(): Promise<HarnessScan> {
    if (this.closing.signal.aborted) return Promise.reject(new Error("Scope is closing."));
    if (this.running) return this.running;
    this.error = null;
    this.running = this.run().then(
      (scan) => {
        this.running = null;
        this.changed();
        return scan;
      },
      (error: unknown) => {
        this.running = null;
        if (!this.closing.signal.aborted) this.error = SCAN_FAILED;
        this.changed();
        throw error;
      },
    );
    this.changed();
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
    // Quitting stops version calls early, so this scan's versions may be wrong.
    if (this.closing.signal.aborted) return run.scan;
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
          this.changed();
          await this.save(scan);
        })
        // The saved scan keeps its pending sizes until the next scan. The tab shows no sizes,
        // so a failed count is only logged.
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

  private reply(): HarnessesReply {
    return { machines: this.latest ? [this.latest] : [] };
  }

  private changed() {
    if (!this.closing.signal.aborted) this.onChange(this.state());
  }

  /** A scan that cannot be saved is still shown; the next scan tries again. */
  private async save(scan: HarnessScan): Promise<void> {
    try {
      if (!(await this.store.save(scan)))
        console.error("The harness scan exceeds 256 KiB and was not saved.");
    } catch {
      console.error("Scope could not save the harness scan.");
    }
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
