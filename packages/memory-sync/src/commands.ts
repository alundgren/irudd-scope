import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type Result = { code: number; stdout: string; stderr: string };
export class SyncError extends Error {}

/** Runs git, gh and irudd-okf with argument escaping for Windows command wrappers. */
export class MemoryCommands {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env?: NodeJS.ProcessEnv) {
    const base = { ...(env ?? process.env) };
    if (process.platform === "win32") {
      // Node passes only one spelling of each Windows environment variable.
      for (const name of ["PATH", "PATHEXT"]) {
        const keys = Object.keys(base).filter((key) => key.toUpperCase() === name);
        const value = base[name] ?? base[keys[0] ?? name];
        for (const key of keys) delete base[key];
        if (value !== undefined) base[name] = value;
      }
    }
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
        `credential.helper=!'${(process.platform === "win32" ? gh.replaceAll("\\", "/") : gh).replaceAll("'", "'\\''")}' auth git-credential`,
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
    const extensions =
      process.platform === "win32" && !extname(command)
        ? [
            ...(this.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
              .split(";")
              .filter((extension) => /^\.(com|exe|bat|cmd)$/i.test(extension)),
            "",
          ]
        : [""];
    for (const directory of (this.env.PATH ?? "").split(delimiter)) {
      const path = directory.replace(/^"(.*)"$/, "$1");
      if (!path || !isAbsolute(path)) continue;
      for (const extension of extensions) {
        const candidate = join(path, command + extension);
        try {
          await access(candidate, constants.X_OK);
          if ((await stat(candidate)).isFile()) return candidate;
        } catch {
          // Continue through PATH when an entry is missing or cannot be executed.
        }
      }
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
      let stopping: Promise<void> | undefined;
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
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform === "win32" && child.pid) {
            // Killing cmd.exe alone would leave the command it launched running.
            stopping ??= new Promise<void>((resolve) => {
              execFile(
                join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
                ["/pid", String(child.pid), "/t", "/f"],
                { windowsHide: true, timeout: 5000 },
                (error) => {
                  if (error) child.kill("SIGKILL");
                  resolve();
                },
              );
            });
            return;
          }
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* The command may have exited before cancellation. */
        }
      };
      const stop = () => {
        stopped = true;
        kill("SIGTERM");
        if (process.platform !== "win32" && command !== "git" && !forceTimer)
          forceTimer = setTimeout(() => kill("SIGKILL"), 5000);
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
      child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => {
        problem = error.message;
      });
      child.on("close", async (code) => {
        if (process.platform !== "win32" && stopped && command !== "git") kill("SIGKILL");
        clearTimeout(timer);
        clearTimeout(forceTimer);
        options.signal?.removeEventListener("abort", stop);
        await stopping;
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
