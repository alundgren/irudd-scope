import spawn from "cross-spawn";
import { delimiter } from "node:path";

export type WorkspaceGitHubErrorKind =
  | "auth"
  | "permission"
  | "scope"
  | "network"
  | "throttle"
  | "invalid"
  | "comparison"
  | "cancelled"
  | "unavailable"
  | "account";

export class WorkspaceGitHubError extends Error {
  constructor(
    message: string,
    readonly kind: WorkspaceGitHubErrorKind = "invalid",
    readonly retryAt: number | null = null,
    readonly diagnostic: { status?: number; code?: string } = {},
    readonly account: string | null = null,
  ) {
    super(message);
    this.name = "WorkspaceGitHubError";
  }
}

export interface GitHubRateObservation {
  account: string;
  cost: number;
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface GitHubTransport {
  graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    priority?: number,
  ): Promise<{ data: T; observation: GitHubRateObservation }>;
  rest<T = unknown>(path: string, signal: AbortSignal, priority?: number): Promise<T>;
  prDiff(
    owner: string,
    name: string,
    number: number,
    signal: AbortSignal,
    priority?: number,
  ): Promise<string>;
  account(signal: AbortSignal): Promise<string>;
  setHooks(
    observe?: (observation: GitHubRateObservation) => void,
    beforeRead?: (signal: AbortSignal) => Promise<void> | void,
  ): void;
}

export function classifyGitHubFailure(text: string, now = Date.now()): WorkspaceGitHubError {
  if (/INSUFFICIENT_SCOPES|read:project|project.*scope/i.test(text)) {
    return new WorkspaceGitHubError(
      "Your GitHub CLI token needs the read:project scope. Run: gh auth refresh -s read:project",
      "scope",
      null,
      { code: "INSUFFICIENT_SCOPES" },
    );
  }
  const statusText = /(?:HTTP(?:\/[^\s]+)?\s+|status[=: ]+)(401|403|404|429|5\d\d)\b/i.exec(
    text,
  )?.[1];
  const status = statusText ? Number(statusText) : undefined;
  const retry = /retry-after\s*:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim();
  const reset = /x-ratelimit-reset\s*:\s*(\d+)/i.exec(text)?.[1];
  const exhausted = /x-ratelimit-remaining\s*:\s*0\b/i.test(text);
  const cleaned = text.replace(/^\s*(?:x-ratelimit-[^\r\n]*|retry-after:[^\r\n]*)/gim, "");
  const throttle =
    status === 429 ||
    exhausted ||
    /rate[ _-]limit(?:ed| exceeded|ing|\b)|secondary rate|abuse detection|RATE_LIMITED/i.test(
      cleaned,
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
    return new WorkspaceGitHubError(
      "GitHub has limited requests. Refresh will retry later.",
      "throttle",
      retryAt,
      { status, code: "RATE_LIMITED" },
    );
  }
  if (/network|timeout|connection|resolve host|dial tcp/i.test(text) || (status && status >= 500))
    return new WorkspaceGitHubError(
      "GitHub could not be reached. Try Sync again.",
      "network",
      null,
      {
        status,
      },
    );
  if (status === 401 || /gh auth login|authentication|bad[ _]credentials/i.test(text))
    return new WorkspaceGitHubError(
      "Sign in with gh auth login, then try Sync again.",
      "auth",
      null,
      {
        status,
      },
    );
  if (
    status === 403 ||
    status === 404 ||
    /not accessible|could not resolve to a repository|FORBIDDEN/i.test(text)
  )
    return new WorkspaceGitHubError(
      "Your GitHub CLI account cannot read this repository or project.",
      "permission",
      null,
      { status },
    );
  return new WorkspaceGitHubError(
    "GitHub CLI could not complete the read. Try Sync again.",
    "unavailable",
    null,
    { status },
  );
}

function parseHttpBody(raw: string): unknown {
  const split =
    raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
  const body = split > 1 && raw.startsWith("HTTP/") ? raw.slice(split) : raw;
  return JSON.parse(body);
}

export class GhCliTransport implements GitHubTransport {
  private active = false;
  private readonly pending: { priority: number; start: () => void }[] = [];
  private observe?: (observation: GitHubRateObservation) => void;
  private beforeRead?: (signal: AbortSignal) => Promise<void> | void;

  constructor(
    private readonly executable = "gh",
    private readonly timeoutMs = 45_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  setHooks(
    observe?: (observation: GitHubRateObservation) => void,
    beforeRead?: (signal: AbortSignal) => Promise<void> | void,
  ): void {
    this.observe = observe;
    this.beforeRead = beforeRead;
  }

  private enqueue(
    args: readonly string[],
    signal: AbortSignal,
    priority: number,
    stdin?: string,
    skipBeforeRead = false,
  ): Promise<string> {
    if (signal.aborted)
      return Promise.reject(new WorkspaceGitHubError("GitHub refresh was cancelled.", "cancelled"));
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        start: () => {
          signal.removeEventListener("abort", cancelled);
          if (signal.aborted) {
            reject(new WorkspaceGitHubError("GitHub refresh was cancelled.", "cancelled"));
            this.advance();
            return;
          }
          Promise.resolve()
            .then(() => (skipBeforeRead ? undefined : this.beforeRead?.(signal)))
            .then(() => this.execute(args, signal, stdin))
            .then(resolve, reject)
            .finally(() => this.advance());
        },
      };
      const cancelled = () => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) {
          this.pending.splice(idx, 1);
          reject(new WorkspaceGitHubError("GitHub refresh was cancelled.", "cancelled"));
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

  private execute(args: readonly string[], signal: AbortSignal, stdin?: string): Promise<string> {
    if (signal.aborted)
      throw new WorkspaceGitHubError("GitHub refresh was cancelled.", "cancelled");
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (process.platform === "darwin")
        env.PATH = [env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].join(
          delimiter,
        );
      const child = spawn(this.executable, [...args], {
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
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
          // Process may have exited already.
        }
      };
      const abort = () =>
        stop(new WorkspaceGitHubError("GitHub refresh was cancelled.", "cancelled"));
      const timer = setTimeout(
        () =>
          stop(
            new WorkspaceGitHubError("GitHub did not respond in time. Try Sync again.", "network"),
          ),
        this.timeoutMs,
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      if (stdin !== undefined && child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(stdin, "utf8");
      }
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > this.maxBytes) {
          stop(
            new WorkspaceGitHubError(
              "GitHub returned too much data. The saved workspace was kept.",
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 65_536)
          stderr += chunk.toString("utf8").slice(0, 65_536 - stderr.length);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(
          new WorkspaceGitHubError(
            error.code === "ENOENT"
              ? "Install GitHub CLI (gh) to refresh this workspace."
              : "GitHub CLI could not start. Try Sync again.",
          ),
        );
      });
      child.on("close", (code) => {
        if (stopped) return finish(stopped);
        const stdout = Buffer.concat(chunks).toString("utf8");
        if (code === 0) finish(undefined, stdout);
        else finish(classifyGitHubFailure(`${stdout}\n${stderr}`));
      });
    });
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    priority = 0,
  ): Promise<{ data: T; observation: GitHubRateObservation }> {
    const raw = await this.enqueue(
      ["api", "graphql", "--include", "--hostname", "github.com", "--input", "-"],
      signal,
      priority,
      JSON.stringify({ query, variables }),
    );
    const parsed = parseHttpBody(raw) as {
      data?: Record<string, unknown>;
      errors?: { type?: string; message?: string }[];
    };
    const data = parsed?.data;
    const rate = data?.rateLimit as
      | { cost: number; limit: number; remaining: number; resetAt: string }
      | undefined;
    const viewer = data?.viewer as { login: string } | undefined;
    if (rate && viewer?.login) {
      const observation: GitHubRateObservation = { account: viewer.login, ...rate };
      this.observe?.(observation);
      if (parsed.errors?.length) {
        throw classifyGitHubFailure(JSON.stringify(parsed.errors));
      }
      return { data: data as T, observation };
    }
    if (parsed.errors?.length) throw classifyGitHubFailure(JSON.stringify(parsed.errors));
    throw new WorkspaceGitHubError("GitHub returned an unreadable GraphQL response.");
  }

  async rest<T = unknown>(path: string, signal: AbortSignal, priority = 1): Promise<T> {
    const raw = await this.enqueue(
      ["api", "--include", "--hostname", "github.com", "--method", "GET", path],
      signal,
      priority,
    );
    return parseHttpBody(raw) as T;
  }

  prDiff(
    owner: string,
    name: string,
    number: number,
    signal: AbortSignal,
    priority = 1,
  ): Promise<string> {
    return this.enqueue(
      ["pr", "diff", String(number), "--repo", `github.com/${owner}/${name}`, "--color", "never"],
      signal,
      priority,
    );
  }

  async account(signal: AbortSignal): Promise<string> {
    const raw = await this.enqueue(
      ["api", "--hostname", "github.com", "--include", "user"],
      signal,
      2,
      undefined,
      true,
    );
    const user = parseHttpBody(raw) as { login?: string };
    if (!user?.login) throw new WorkspaceGitHubError("Sign in with gh auth login.", "auth");
    return user.login;
  }
}
