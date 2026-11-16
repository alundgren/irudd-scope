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
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
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
