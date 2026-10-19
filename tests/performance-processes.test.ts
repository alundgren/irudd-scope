import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { killProcessGroup } from "../tools/performance/processes.ts";

test.runIf(process.platform === "linux")(
  "performance cancellation stops a mutating grandchild that ignores SIGTERM",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scope-performance-cancel-"));
    const marker = join(directory, "writes.txt");
    const grandchild = `import { appendFileSync } from 'node:fs'; process.on('SIGTERM',()=>{}); setInterval(()=>appendFileSync(${JSON.stringify(marker)}, 'x'),10);`;
    const program = `import { spawn } from 'node:child_process'; spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(grandchild)}],{stdio:'ignore'}); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("");
      killProcessGroup(child.pid!, "SIGTERM");
      await delay(50);
      killProcessGroup(child.pid!, "SIGKILL");
      await delay(50);
      const content = await readFile(marker, "utf8");
      await delay(100);
      expect(await readFile(marker, "utf8")).toBe(content);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      killProcessGroup(child.pid!, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform === "linux")(
  "performance cleanup discovers an unregistered detached mutator after its worker is killed",
  async () => {
    const { OwnedProcesses } = await import("../tools/performance/processes.ts");
    const directory = await mkdtemp(join(tmpdir(), "scope-performance-detached-"));
    const marker = join(directory, "writes.txt");
    const token = `scope-performance-test-${crypto.randomUUID()}`;
    const supervisor = new OwnedProcesses(token);
    const mutator = `process.title="scope-owned-mutator"; import {appendFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); setInterval(()=>appendFileSync(${JSON.stringify(marker)},'x'),10);`;
    const program = `import {spawn} from 'node:child_process'; spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(mutator)}],{detached:true,argv0:${JSON.stringify(token)},env:{...process.env,SCOPE_PERFORMANCE_MARKER:${JSON.stringify(token)}},stdio:'ignore'}); setInterval(()=>{},1000);`;
    const worker = spawn(process.execPath, ["--input-type=module", "-e", program], {
      detached: true,
      stdio: "ignore",
    });
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).not.toBe("");
      killProcessGroup(worker.pid!, "SIGKILL");
      const before = await readFile(marker, "utf8");
      await delay(60);
      expect((await readFile(marker, "utf8")).length).toBeGreaterThan(before.length);
      expect((await supervisor.discover()).length).toBeGreaterThan(0);
      await supervisor.terminate();
      const after = await readFile(marker, "utf8");
      await delay(100);
      expect(await readFile(marker, "utf8")).toBe(after);
      expect(await supervisor.discover()).toEqual([]);
    } finally {
      killProcessGroup(worker.pid!, "SIGKILL");
      await supervisor.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
