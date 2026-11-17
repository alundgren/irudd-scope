import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * Starts a chat program in its own process group, so closing the chat or quitting Scope stops
 * it and everything it started.
 */
export function startProgram(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessByStdio<Writable, Readable, null> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  // Commands the program started in the background would outlive it, so they stop with it.
  child.once("exit", () => killGroup(child));
  return child;
}

function killGroup(child: ChildProcess) {
  if (!child.pid || process.platform === "win32") return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Nothing is left in the group.
  }
}

/** Stops a program Scope started and everything it started, the way gh calls are stopped. */
export function stopGroup(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The program can exit between the check and the kill.
  }
}

/** Fails once `signal` aborts, so a request to a program that hangs can be given up. */
export function untilAborted(signal: AbortSignal, message: string): Promise<never> {
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error(message));
    else signal.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
  aborted.catch(() => {});
  return aborted;
}
