import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

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
      detached: true,
    });
    let output = "";
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const receive = (chunk: Buffer) => {
      output = (output + stripVTControlCharacters(chunk.toString())).slice(-16_000);
      options.onOutput?.(output);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const abort = () => {
      killGroup("SIGTERM");
      forceKill = setTimeout(() => killGroup("SIGKILL"), 2000);
      forceKill.unref();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (forceKill) clearTimeout(forceKill);
      if (options.signal.aborted) fail(new Error("The operation was canceled or timed out."));
      else if (code !== 0)
        fail(new Error(output.trim() || "The installation command could not run."));
      else done(output.trim());
    });
  });
}
