import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type Result = { code: number; stdout: string; stderr: string };
export class SyncError extends Error {}

/** Runs git, gh and irudd-okf without a shell or interactive prompts. */
export class MemoryCommands {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env?: NodeJS.ProcessEnv) {
    const base = { ...(env ?? process.env) };
    // GUI launches on macOS omit the package-manager and per-user directories.
    if (!env)
      base.PATH = [
        base.PATH ?? "",
        ...(process.platform === "darwin"
          ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
          : []),
        join(homedir(), ".local/bin"),
      ]
        .filter(Boolean)
        .join(delimiter);
    this.env = {
      ...base,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
  }

  async git(
    directory: string,
    args: string[],
    signal: AbortSignal,
    options: { credentials?: boolean; identity?: boolean } = {},
  ) {
    const prefix = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
    if (options.credentials) {
      const gh = await this.resolve("gh");
      if (!gh) throw new SyncError("gh is not installed on this machine.");
      prefix.push(
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=!'${gh.replaceAll("'", "'\\''")}' auth git-credential`,
      );
    }
    if (options.identity) {
      const email = await this.run("git", ["config", "user.email"], { cwd: directory, signal });
      if (email.code !== 0 || !email.stdout.trim())
        prefix.push("-c", "user.name=Scope", "-c", "user.email=noreply@irudd-scope");
    }
    return this.run("git", [...prefix, ...args], { cwd: directory, signal });
  }

  async resolve(command: string) {
    for (const directory of (this.env.PATH ?? "").split(delimiter)) {
      if (!directory || !isAbsolute(directory)) continue;
      const candidate = join(directory, command);
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return candidate;
    }
    return undefined;
  }

  async run(
    command: string,
    args: string[],
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<Result> {
    if (options.signal?.aborted)
      return { code: 1, stdout: "", stderr: "Memory operation stopped." };
    const executable = await this.resolve(command);
    if (!executable) return { code: 127, stdout: "", stderr: `${command} is not installed.` };
    if (command === "git" && executable === "/usr/bin/git" && process.platform === "darwin") {
      // /usr/bin/git opens an installer dialog when the command line tools are missing.
      const tools = await this.run("xcode-select", ["-p"]);
      if (tools.code !== 0)
        return { code: 127, stdout: "", stderr: "Install the Xcode command line tools for git." };
    }
    if (options.signal?.aborted)
      return { code: 1, stdout: "", stderr: "Memory operation stopped." };
    return new Promise((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let problem: string | undefined;
      let argument = 0;
      while (args[argument] === "-c") argument += 2;
      const mutation =
        command === "git" &&
        ["add", "commit", "merge", "rebase", "reset"].includes(args[argument] ?? "");
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: this.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* The command may have exited before cancellation. */
        }
      };
      const stop = () => {
        stopped = true;
        kill("SIGTERM");
        if (command !== "git" && !forceTimer) forceTimer = setTimeout(() => kill("SIGKILL"), 5000);
      };
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const collect = (output: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
        if (remaining) output.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES && !problem) {
          problem = "Memory command output exceeds 4 MiB.";
          if (!mutation) stop();
        }
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => {
        problem = error.message;
      });
      child.on("close", (code) => {
        if (stopped && command !== "git") kill("SIGKILL");
        clearTimeout(timer);
        clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", stop);
        done({
          code: problem ? 1 : (code ?? 1),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr:
            Buffer.concat(stderr).toString("utf8") ||
            problem ||
            (stopped ? "Memory command stopped." : ""),
        });
      });
      // Stop between git mutations; aborting one can leave partially updated working files.
      if (!mutation)
        timer = setTimeout(() => {
          problem = "Memory command timed out.";
          stop();
        }, COMMAND_TIMEOUT_MS);
      if (command !== "git") {
        options.signal?.addEventListener("abort", stop, { once: true });
        if (options.signal?.aborted) stop();
      }
    });
  }
}
