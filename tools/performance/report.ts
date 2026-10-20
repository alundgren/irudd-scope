import {
  appendFileSync,
  closeSync,
  fsyncSync,
  fstatSync,
  readSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type Coverage = {
  status: "measured" | "failed" | "unavailable" | "unmeasured";
  reason: string;
  samples: number;
};
export type Event = { type: string; at: string; elapsedMs: number; [key: string]: unknown };
export class Report {
  readonly started = performance.now();
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    for (const file of ["events.jsonl", "resources.jsonl", "external.jsonl"]) {
      const fd = openSync(join(directory, file), "a+");
      const size = fstatSync(fd).size;
      try {
        if (size) {
          const last = Buffer.alloc(1);
          readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 10) appendFileSync(fd, "\n");
        }
      } finally {
        closeSync(fd);
      }
    }
  }
  write(file: string, data: unknown) {
    const path = join(this.directory, file);
    writeFileSync(`${path}.next`, JSON.stringify(data, null, 2) + "\n");
    renameSync(`${path}.next`, path);
  }
  event(type: string, data: Record<string, unknown> = {}, file = "events.jsonl") {
    appendFileSync(
      join(this.directory, file),
      JSON.stringify({
        type,
        at: new Date().toISOString(),
        elapsedMs: performance.now() - this.started,
        ...data,
      }) + "\n",
    );
  }
  sync() {
    for (const file of ["events.jsonl", "resources.jsonl", "external.jsonl"]) {
      const fd = openSync(join(this.directory, file), "a");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
}
export function rows(directory: string, file: string): Event[] {
  return readFileSync(join(directory, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Event];
      } catch {
        return [];
      }
    });
}
export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  };
}
function operationKey(row: Event) {
  return [row.phase, row.workload, row.feature, row.operation, row.metric].map(String).join("/");
}
function externalKey(row: Event) {
  return [
    row.phase ?? "setup",
    row.workload ?? "setup",
    row.feature,
    row.tool,
    row.native ? "native" : "synthetic",
  ]
    .map(String)
    .join("/");
}
function grouped(events: Event[], key: (row: Event) => string) {
  const buckets = new Map<string, Event[]>();
  for (const event of events) {
    const name = key(event);
    const values = buckets.get(name) ?? [];
    values.push(event);
    buckets.set(name, values);
  }
  return buckets;
}
export function summarize(directory: string) {
  const events = rows(directory, "events.jsonl");
  const operations = events.filter((row) => row.type === "operation");
  const external = rows(directory, "external.jsonl").filter((row) => row.type === "external-end");
  const externalGroups = grouped(external, externalKey);
  const samples = rows(directory, "resources.jsonl").filter((row) => row.type === "sample");
  const phaseRows = events.filter((row) => row.type === "phase");
  const end = events.findLast((row) => row.type === "measurement-end");
  const allocations = phaseRows.map((row, index) => ({
    phase: row.phase,
    startMs: row.measuredElapsedMs,
    durationMs: Math.max(
      0,
      Number(
        phaseRows[index + 1]?.measuredElapsedMs ?? end?.measuredElapsedMs ?? row.measuredElapsedMs,
      ) - Number(row.measuredElapsedMs),
    ),
  }));
  const longestSessionMs = Math.max(
    0,
    ...samples.map((row) => Number(row.sessionAgeMs)),
    ...events.filter((row) => row.type === "session").map((row) => Number(row.ageMs ?? 0)),
  );

  const operationGroups = grouped(operations, operationKey);
  const coverage: Record<string, Coverage> = {};
  for (const event of events.filter((row) => row.type === "coverage"))
    coverage[String(event.feature)] = event.value as Coverage;
  return {
    updatedAt: new Date().toISOString(),
    percentileDefinition:
      "Nearest rank: sorted[ceil(p * count) - 1]. No interpolation. Empty samples are null.",
    units: {
      duration: "milliseconds",
      rss: "bytes; shared pages can be counted in multiple processes",
      electronCpu: "percentCPUUsage average since previous centralized sample",
      externalUsage:
        "/usr/bin/time userSeconds/systemSeconds/maxRssKiB; wrapperCpuMicroseconds is separate",
    },
    measurements: Object.fromEntries(
      [...operationGroups].map(([key, matching]) => [
        key,
        {
          ...percentiles(
            matching.filter((row) => row.status === "ok").map((row) => Number(row.durationMs)),
          ),
          failures: matching.filter((row) => row.status !== "ok").length,
        },
      ]),
    ),
    coverage,
    actualPhaseAllocation: allocations,
    longestSessionMs,
    externalCommands: Object.fromEntries(
      [...externalGroups].map(([key, matching]) => [
        key,
        percentiles(matching.map((row) => Number(row.durationMs))),
      ]),
    ),
    resourceSamples: samples.length,
    rendererIntervals: samples.map((row) => ({
      phase: row.phase,
      workload: row.workload,
      sessionAgeMs: row.sessionAgeMs,
      intervalMs: row.intervalMs,
      renderer: row.renderer,
    })),
    failures: events.filter((row) =>
      ["failure", "timeout", "recovery", "safeguard"].includes(row.type),
    ),
    phases: events.filter((row) =>
      ["phase", "session", "checkpoint", "cleanup"].includes(row.type),
    ),
    limitations: [
      "Linux visible Xvfb windows with GPU disabled. No hardware GPU, macOS/Windows, native dialogs, paid providers, live GitHub, SSH or Tailcat relay measurements.",
      "Synthetic GitHub, memory sync and transport timings establish integration behavior only. Native OKF is measured only when explicitly supplied.",
      "External intervals and end-to-end timings can overlap. Residual time is unattributed, not automatically Scope CPU time. RSS growth alone does not establish a leak.",
      "Standard test-suite wall time is never an application responsiveness metric.",
    ],
  };
}
