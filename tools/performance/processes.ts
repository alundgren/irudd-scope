import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export function killProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
type Process = { pid: number; group: number; state: string; started: string };
async function processes(): Promise<Process[]> {
  const entries = await readdir("/proc");
  const result: Process[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const raw = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    if (fields.length > 19)
      result.push({
        pid: Number(entry),
        state: fields[0],
        group: Number(fields[2]),
        started: fields[19],
      });
  }
  return result;
}
export class OwnedProcesses {
  readonly marker: string;
  private groups = new Map<number, string>();
  constructor(marker: string) {
    this.marker = marker;
  }
  registerGroup(pid: number) {
    if (!this.groups.has(pid)) this.groups.set(pid, "");
  }
  async discover() {
    const all = await processes();
    for (const process of all) {
      const command = await readFile(`/proc/${process.pid}/cmdline`).catch(() => Buffer.alloc(0));
      const markedCommand = command
        .subarray(0, this.marker.length + 1)
        .equals(Buffer.from(this.marker + "\0"));
      // The inherited marker also identifies children that changed argv[0] before registration.
      const environment = markedCommand
        ? Buffer.alloc(0)
        : await readFile(`/proc/${process.pid}/environ`).catch(() => Buffer.alloc(0));
      const markedEnvironment = Buffer.concat([Buffer.from("\0"), environment]).includes(
        Buffer.from(`\0SCOPE_PERFORMANCE_MARKER=${this.marker}\0`),
      );
      if (markedCommand || markedEnvironment) {
        const leader = all.find((item) => item.pid === process.group);
        this.groups.set(process.group, leader?.started ?? "");
      }
    }
    return this.active(all);
  }
  private active(all: Process[]) {
    for (const [group, started] of this.groups) {
      const leader = all.find((item) => item.pid === group);
      if (leader && started && leader.started !== started) this.groups.delete(group);
    }
    return all.filter(
      (item) => this.groups.has(item.group) && item.state !== "Z" && item.state !== "X",
    );
  }
  async terminate() {
    await this.discover();
    for (const group of this.groups.keys()) killProcessGroup(group, "SIGKILL");
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const active = await this.discover();
      if (!active.length) {
        const groups = [...this.groups.keys()];
        this.groups.clear();
        return { groups, active: [] };
      }
      for (const group of new Set(active.map((item) => item.group)))
        killProcessGroup(group, "SIGKILL");
      await delay(50);
    }
    throw new Error(
      `Owned processes remain active: ${(await this.discover()).map((item) => item.pid).join(", ")}`,
    );
  }
}
