import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";

export function windowsPowerShell() {
  return join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
}

export function runInstallationCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onOutput?: (output: string) => void;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((done, fail) => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let windowsTermination: Promise<void> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const receive = (chunk: string) => {
      output = (output + stripVTControlCharacters(chunk)).slice(-16_000);
      options.onOutput?.(output);
    };
    child.stdout.setEncoding("utf8").on("data", receive);
    child.stderr.setEncoding("utf8").on("data", receive);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const abort = () => {
      if (process.platform === "win32") {
        if (child.pid)
          windowsTermination = new Promise((resolve) => {
            const killer = spawn(
              join(process.env.SystemRoot ?? "C:\\Windows", "System32/taskkill.exe"),
              ["/PID", String(child.pid), "/T", "/F"],
              {
                stdio: "ignore",
                windowsHide: true,
              },
            );
            killer.once("error", () => {
              child.kill();
              resolve();
            });
            killer.once("close", () => resolve());
          });
        return;
      }
      killGroup("SIGTERM");
      forceKill = setTimeout(() => killGroup("SIGKILL"), 2000);
      forceKill.unref();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("close", async (code) => {
      await windowsTermination;
      options.signal.removeEventListener("abort", abort);
      if (forceKill) clearTimeout(forceKill);
      if (options.signal.aborted) fail(new Error("The operation was canceled or timed out."));
      else if (code !== 0)
        fail(new Error(output.trim() || "The installation command could not run."));
      else done(output.trim());
    });
  });
}
