import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
for (const scenario of [
  "never-ready",
  "early-exit",
  "failed-worker",
  "watchdog-starved",
] as const) {
  test.runIf(process.platform === "linux")(
    `performance controller rejects a non-smoke ${scenario} run`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "scope-performance-outcome-"));
      try {
        const worker = join(directory, "worker.mjs");
        const source =
          scenario === "never-ready"
            ? "setInterval(()=>process.send?.({heartbeat:true}),20);"
            : scenario === "early-exit"
              ? "process.send?.({ready:true}); setTimeout(()=>process.exit(0),40);"
              : scenario === "watchdog-starved"
                ? 'process.send?.({ready:true}); setInterval(()=>process.send?.({type:"activity"}),20);'
                : "process.exit(2);";
        await writeFile(worker, source);
        const runDir = join(directory, "run");
        const program = `import {runPerformance} from ${JSON.stringify(pathToFileURL(resolve("tools/performance.ts")).href)}; await runPerformance({runDir:${JSON.stringify(runDir)},durationMs:5000,smoke:false,injectFailure:false},{workerEntrypoint:${JSON.stringify(worker)},setupTimeoutMs:200,pollMs:20,heartbeatTimeoutMs:${scenario === "watchdog-starved" ? 120 : 45000}});`;
        await expect(
          exec(process.execPath, ["--input-type=module", "-e", program], { timeout: 15_000 }),
        ).rejects.toMatchObject({ code: 1 });
        const state = JSON.parse(await readFile(join(runDir, "run-state.json"), "utf8"));
        expect(state.status).toBe("failed");
        expect(state.processesStopped).toBe(true);
        expect(state.incomplete).toContain("Requested measurement duration did not complete");
        if (scenario === "never-ready" || scenario === "failed-worker")
          expect(state.incomplete).toContain("Measurement never began");
        expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toContain("run-completeness");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
