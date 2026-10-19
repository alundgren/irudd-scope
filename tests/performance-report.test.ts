import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, summarize } from "../tools/performance/report.ts";

test("partial performance reports retain failures, sample counts and coverage after a writer restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-performance-report-"));
  try {
    let report = new Report(directory);
    const operation = {
      phase: "baseline",
      workload: "small",
      feature: "viewer",
      operation: "open",
      metric: "interaction",
    };
    for (const durationMs of [1, 2, 3, 4, 100])
      report.event("operation", { ...operation, durationMs, status: "ok" });
    report.event("operation", { ...operation, durationMs: 30_000, status: "failed" });
    report.event("coverage", {
      feature: "native",
      value: { status: "unmeasured", reason: "Native binary unavailable", samples: 0 },
    });
    report.sync();
    report = new Report(directory);
    report.event("failure", { operation: "recovery", error: "Synthetic failed recovery" });
    await appendFile(join(directory, "events.jsonl"), '{"incomplete":');
    const summary = summarize(directory);
    expect(summary.measurements["baseline/small/viewer/open/interaction"]).toEqual({
      count: 5,
      min: 1,
      p50: 3,
      p90: 100,
      p95: 100,
      p99: 100,
      max: 100,
      failures: 1,
    });
    expect(summary.coverage.native).toMatchObject({
      status: "unmeasured",
      reason: "Native binary unavailable",
    });
    expect(summary.failures).toHaveLength(1);
    report.write("summary.json", summary);
    expect(
      JSON.parse(await readFile(join(directory, "summary.json"), "utf8")).measurements,
    ).toEqual(summary.measurements);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
