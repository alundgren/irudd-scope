import { spawn } from "node:child_process";
import { delimiter } from "node:path";

export class GitHubReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubReadError";
  }
}

export class GitHubProcess {
  constructor(
    private readonly executable = "gh",
    private readonly timeoutMs = 45_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  run(args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
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
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(output ?? "");
      };
      const stop = (error: Error) => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // A process can exit between the cancellation and kill calls.
        }
        finish(error);
      };
      const abort = () => stop(new GitHubReadError("GitHub refresh was cancelled."));
      const timer = setTimeout(
        () => stop(new GitHubReadError("GitHub did not respond in time. Try Sync again.")),
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
        if (code === 0) finish(undefined, Buffer.concat(chunks).toString("utf8"));
        else {
          const message = /network|timeout|connection|resolve host|dial tcp/i.test(stderr)
            ? "GitHub could not be reached. Try Sync again."
            : /gh auth login|authentication|HTTP 401/i.test(stderr)
              ? "Sign in with gh auth login, then try Sync again."
              : /HTTP 403|HTTP 404|not accessible|could not resolve to a repository/i.test(stderr)
                ? "Your GitHub CLI account cannot read this repository."
                : "GitHub CLI could not complete the read. Try Sync again.";
          finish(new GitHubReadError(message));
        }
      });
    });
  }
}
