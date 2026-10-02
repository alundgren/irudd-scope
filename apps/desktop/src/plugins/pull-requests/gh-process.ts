import { spawn } from "node:child_process";
import { delimiter } from "node:path";

export type GitHubReadErrorKind =
  | "auth"
  | "permission"
  | "network"
  | "throttle"
  | "invalid"
  | "cancelled"
  | "unavailable"
  | "account";

export class GitHubReadError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubReadErrorKind = "invalid",
    readonly retryAt: number | null = null,
    readonly diagnostic: { status?: number; code?: string } = {},
    readonly account: string | null = null,
  ) {
    super(message);
    this.name = "GitHubReadError";
  }
}

export function githubFailure(text: string, now = Date.now()): GitHubReadError {
  const statusText = /(?:HTTP(?:\/[^\s]+)?\s+|status[=: ]+)(401|403|404|429|5\d\d)\b/i.exec(
    text,
  )?.[1];
  const status = statusText ? Number(statusText) : undefined;
  const retry = /retry-after\s*:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim();
  const reset = /x-ratelimit-reset\s*:\s*(\d+)/i.exec(text)?.[1];
  const exhausted = /x-ratelimit-remaining\s*:\s*0\b/i.test(text);
  const errorText = text.replace(/^\s*(?:x-ratelimit-[^\r\n]*|retry-after:[^\r\n]*)/gim, "");
  const throttle =
    status === 429 ||
    exhausted ||
    /rate[ _-]limit(?:ed| exceeded|ing|\b)|secondary rate|abuse detection|RATE_LIMITED/i.test(
      errorText,
    );
  if (throttle) {
    const retryDate =
      retry && /^\d+(?:\.\d+)?$/.test(retry)
        ? now + Number(retry) * 1000
        : retry
          ? Date.parse(retry)
          : NaN;
    const resetDate = exhausted && reset ? Number(reset) * 1000 : NaN;
    const retryAt = Math.max(
      now + 1_000,
      ...[retryDate, resetDate].filter(Number.isFinite),
      now + (!Number.isFinite(retryDate) && !Number.isFinite(resetDate) ? 60_000 : 0),
    );
    return new GitHubReadError(
      "GitHub has limited requests. Refresh will retry later.",
      "throttle",
      retryAt,
      { status, code: "RATE_LIMITED" },
    );
  }
  if (/network|timeout|connection|resolve host|dial tcp/i.test(text) || (status && status >= 500))
    return new GitHubReadError("GitHub could not be reached. Try Sync again.", "network", null, {
      status,
    });
  if (status === 401 || /gh auth login|authentication|bad[ _]credentials/i.test(text))
    return new GitHubReadError("Sign in with gh auth login, then try Sync again.", "auth", null, {
      status,
    });
  if (
    status === 403 ||
    status === 404 ||
    /not accessible|could not resolve to a repository|FORBIDDEN/i.test(text)
  )
    return new GitHubReadError(
      "Your GitHub CLI account cannot read this repository.",
      "permission",
      null,
      { status },
    );
  return new GitHubReadError(
    "GitHub CLI could not complete the read. Try Sync again.",
    "unavailable",
    null,
    { status },
  );
}

export class GitHubProcess {
  constructor(
    private readonly executable = "gh",
    private readonly timeoutMs = 45_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  private active = false;
  private readonly pending: { priority: number; start: () => void }[] = [];

  run(
    args: readonly string[],
    signal: AbortSignal,
    priority = 0,
    beforeStart?: () => Promise<void> | void,
  ): Promise<string> {
    if (signal.aborted)
      return Promise.reject(new GitHubReadError("GitHub refresh was cancelled.", "cancelled"));
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        start: () => {
          signal.removeEventListener("abort", cancelled);
          if (signal.aborted) {
            reject(new GitHubReadError("GitHub refresh was cancelled.", "cancelled"));
            this.advance();
            return;
          }
          Promise.resolve()
            .then(beforeStart)
            .then(() => this.execute(args, signal))
            .then(resolve, reject)
            .finally(() => this.advance());
        },
      };
      const cancelled = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) {
          this.pending.splice(index, 1);
          reject(new GitHubReadError("GitHub refresh was cancelled.", "cancelled"));
        }
      };
      signal.addEventListener("abort", cancelled, { once: true });
      this.pending.push(entry);
      if (!this.active) this.advance();
    });
  }

  private advance() {
    this.active = false;
    this.pending.sort((a, b) => b.priority - a.priority);
    const next = this.pending.shift();
    if (next) {
      this.active = true;
      next.start();
    }
  }

  private execute(args: readonly string[], signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new GitHubReadError("GitHub refresh was cancelled.", "cancelled");
    return new Promise((resolve, reject) => {
      // Finder launches commonly omit the package-manager directories from PATH.
      const env = { ...process.env };
      if (process.platform === "darwin")
        env.PATH = [env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].join(
          delimiter,
        );
      const child = spawn(this.executable, [...args], {
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let settled = false;
      let stopped: Error | undefined;
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(output ?? "");
      };
      const stop = (error: Error) => {
        stopped ??= error;
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // A process can exit between the cancellation and kill calls.
        }
      };
      const abort = () => stop(new GitHubReadError("GitHub refresh was cancelled.", "cancelled"));
      const timer = setTimeout(
        () =>
          stop(new GitHubReadError("GitHub did not respond in time. Try Sync again.", "network")),
        this.timeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) {
          stop(new GitHubReadError("GitHub returned too much data. The saved list was kept."));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 65_536)
          stderr += chunk.toString("utf8").slice(0, 65_536 - stderr.length);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(
          new GitHubReadError(
            error.code === "ENOENT"
              ? "Install GitHub CLI (gh) to refresh pull requests."
              : "GitHub CLI could not start. Try Sync again.",
          ),
        );
      });
      child.on("close", (code) => {
        if (stopped) {
          finish(stopped);
          return;
        }
        if (code === 0) finish(undefined, Buffer.concat(chunks).toString("utf8"));
        else {
          finish(githubFailure(Buffer.concat(chunks).toString("utf8") + "\n" + stderr));
        }
      });
    });
  }
}
