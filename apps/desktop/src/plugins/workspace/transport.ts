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

export interface GitHubGraphqlOptions {
  allowNotFound?: boolean;
}

export interface GitHubTransport {
  graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    priority?: number,
    options?: GitHubGraphqlOptions,
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

type ParsedHttpResponse = {
  status?: number;
  headers: Map<string, string>;
  body: string;
};

type GraphqlErrorEntry = {
  type?: string;
  message?: string;
};

function splitHttpResponse(raw: string): ParsedHttpResponse {
  let rest = raw;
  let status: number | undefined;
  let headers = new Map<string, string>();
  while (rest.startsWith("HTTP/")) {
    const crlf = rest.indexOf("\r\n\r\n");
    const lf = rest.indexOf("\n\n");
    const split =
      crlf >= 0 && (lf < 0 || crlf < lf)
        ? { idx: crlf, len: 4 }
        : lf >= 0
          ? { idx: lf, len: 2 }
          : null;
    if (!split) break;
    const head = rest.slice(0, split.idx);
    const lines = head.split(/\r?\n/);
    const statusMatch = /^HTTP\/[^\s]+\s+(\d{3})\b/i.exec(lines[0] ?? "");
    status = statusMatch ? Number(statusMatch[1]) : status;
    headers = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i]!.indexOf(":");
      if (colon <= 0) continue;
      const key = lines[i]!.slice(0, colon).trim().toLowerCase();
      const val = lines[i]!.slice(colon + 1).trim();
      headers.set(key, val);
    }
    rest = rest.slice(split.idx + split.len);
  }
  return { status, headers, body: rest };
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function classifyGitHubFailure(
  raw: string,
  now = Date.now(),
  stderr = "",
): WorkspaceGitHubError {
  const { status: httpStatus, headers, body } = splitHttpResponse(raw);
  const parsed = tryParseJson(body);
  const graphqlErrors: GraphqlErrorEntry[] = Array.isArray(parsed?.errors)
    ? (parsed.errors as GraphqlErrorEntry[])
    : [];
  const jsonMessage = typeof parsed?.message === "string" ? parsed.message : "";

  const stderrStatusText =
    /(?:HTTP(?:\/[^\s]+)?\s+|status[=: ]+)(401|403|404|406|429|5\d\d)\b/i.exec(stderr)?.[1];
  const status = httpStatus ?? (stderrStatusText ? Number(stderrStatusText) : undefined);

  const retry = headers.get("retry-after")?.trim();
  const reset = headers.get("x-ratelimit-reset")?.trim();
  const exhausted = headers.get("x-ratelimit-remaining")?.trim() === "0";

  // Inspect structured GraphQL errors before falling back to body/stderr text patterns.
  if (
    graphqlErrors.some(
      (err) =>
        err?.type === "INSUFFICIENT_SCOPES" ||
        /\bread:project\b|missing required scopes.*project/i.test(err?.message ?? ""),
    )
  ) {
    return new WorkspaceGitHubError(
      "Your GitHub CLI token needs the read:project scope. Run: gh auth refresh -s read:project",
      "scope",
      null,
      { status, code: "INSUFFICIENT_SCOPES" },
    );
  }

  const errorText = [
    jsonMessage,
    ...graphqlErrors.map((err) => err?.message ?? ""),
    parsed ? "" : body,
    stderr,
  ]
    .filter(Boolean)
    .join("\n");

  const throttle =
    status === 429 ||
    exhausted ||
    graphqlErrors.some((err) => err?.type === "RATE_LIMITED") ||
    /rate[ _-]limit(?:ed| exceeded|ing)\b|secondary rate|abuse detection|API rate limit/i.test(
      errorText,
    );
  if (throttle) {
    const retryDate =
      retry && /^\d+(?:\.\d+)?$/.test(retry)
        ? now + Number(retry) * 1000
        : retry
          ? Date.parse(retry)
          : NaN;
    const resetDate = exhausted && reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
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

  if (/INSUFFICIENT_SCOPES|required scopes.*read:project|missing.*read:project/i.test(errorText)) {
    return new WorkspaceGitHubError(
      "Your GitHub CLI token needs the read:project scope. Run: gh auth refresh -s read:project",
      "scope",
      null,
      { status, code: "INSUFFICIENT_SCOPES" },
    );
  }

  if (
    (status !== undefined && status >= 500) ||
    /dial tcp|resolve host|no such host|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection refused|connection reset|connection timed out|TLS handshake timeout|i\/o timeout|network is unreachable|context deadline exceeded/i.test(
      errorText,
    )
  ) {
    return new WorkspaceGitHubError(
      "GitHub could not be reached. Try Sync again.",
      "network",
      null,
      { status },
    );
  }

  if (
    status === 401 ||
    /gh auth login|bad[ _]credentials|requires authentication|not logged into/i.test(errorText)
  ) {
    return new WorkspaceGitHubError(
      "Sign in with gh auth login, then try Sync again.",
      "auth",
      null,
      { status },
    );
  }

  const permError = graphqlErrors.find(
    (err) => err?.type === "FORBIDDEN" || err?.type === "NOT_FOUND",
  );
  if (
    permError ||
    status === 403 ||
    status === 404 ||
    /not accessible|could not resolve to a repository|could not resolve to a project/i.test(
      errorText,
    )
  ) {
    return new WorkspaceGitHubError(
      "Your GitHub CLI account cannot read this repository or project.",
      "permission",
      null,
      { status, code: permError?.type },
    );
  }

  return new WorkspaceGitHubError(
    "GitHub CLI could not complete the read. Try Sync again.",
    "unavailable",
    null,
    { status },
  );
}

function parseHttpBody(raw: string): unknown {
  return JSON.parse(splitHttpResponse(raw).body);
}

type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

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

  private enqueueRaw(
    args: readonly string[],
    signal: AbortSignal,
    priority: number,
    stdin?: string,
    skipBeforeRead = false,
  ): Promise<ExecResult> {
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

  private async enqueue(
    args: readonly string[],
    signal: AbortSignal,
    priority: number,
    stdin?: string,
    skipBeforeRead = false,
  ): Promise<string> {
    const res = await this.enqueueRaw(args, signal, priority, stdin, skipBeforeRead);
    if (res.code !== 0) throw classifyGitHubFailure(res.stdout, Date.now(), res.stderr);
    return res.stdout;
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

  private execute(
    args: readonly string[],
    signal: AbortSignal,
    stdin?: string,
  ): Promise<ExecResult> {
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
      const finish = (error?: Error, result?: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result ?? { code: 0, stdout: "", stderr: "" });
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
        finish(undefined, { code, stdout, stderr });
      });
    });
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
    priority = 0,
    options?: GitHubGraphqlOptions,
  ): Promise<{ data: T; observation: GitHubRateObservation }> {
    const res = await this.enqueueRaw(
      ["api", "graphql", "--include", "--hostname", "github.com", "--input", "-"],
      signal,
      priority,
      JSON.stringify({ query, variables }),
    );
    const { body } = splitHttpResponse(res.stdout);
    const parsed = tryParseJson(body) as {
      data?: Record<string, unknown>;
      errors?: GraphqlErrorEntry[];
    } | null;
    const data = parsed?.data;
    const rate = data?.rateLimit as
      | { cost: number; limit: number; remaining: number; resetAt: string }
      | undefined;
    const viewer = data?.viewer as { login: string } | undefined;
    const observation: GitHubRateObservation | null =
      rate && viewer?.login ? { account: viewer.login, ...rate } : null;
    if (observation) this.observe?.(observation);

    const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    if (data && observation) {
      if (errors.length === 0 && res.code === 0) {
        return { data: data as T, observation };
      }
      // Allow partial GraphQL results when callers explicitly tolerate NOT_FOUND tombstones
      // (gh exits non-zero whenever errors is non-empty, even with usable partial data).
      if (
        options?.allowNotFound &&
        errors.length > 0 &&
        errors.every((err) => err?.type === "NOT_FOUND")
      ) {
        return { data: data as T, observation };
      }
    }
    if (res.code !== 0 || errors.length > 0) {
      throw classifyGitHubFailure(res.stdout, Date.now(), res.stderr);
    }
    throw new WorkspaceGitHubError("GitHub returned an unreadable GraphQL response.");
  }

  async rest<T = unknown>(path: string, signal: AbortSignal, priority = 1): Promise<T> {
    const raw = await this.enqueue(
      ["api", "--include", "--hostname", "github.com", "--method", "GET", path],
      signal,
      priority,
    );
    try {
      return parseHttpBody(raw) as T;
    } catch {
      throw new WorkspaceGitHubError("GitHub returned an unreadable REST response.");
    }
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
    let user: { login?: string } | null = null;
    try {
      user = parseHttpBody(raw) as { login?: string };
    } catch {
      throw new WorkspaceGitHubError("Sign in with gh auth login.", "auth");
    }
    if (!user?.login) throw new WorkspaceGitHubError("Sign in with gh auth login.", "auth");
    return user.login;
  }
}
