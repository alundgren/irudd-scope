import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { killProcessGroup, OwnedProcesses } from "./performance/processes.ts";
import { Report, summarize, rows } from "./performance/report.ts";

export type Options = {
  runDir: string;
  durationMs: number;
  smoke: boolean;
  okfBinary?: string;
  injectFailure: boolean;
};
function options(): Options {
  const args = process.argv.slice(2);
  const value = (key: string) => {
    const index = args.indexOf(key);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`Missing ${key} value`);
    return args[index + 1];
  };
  const known = new Set(["--run-dir", "--duration", "--okf-binary", "--smoke", "--inject-failure"]);
  for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) throw new Error(`Unknown argument ${args[i]}`);
    if (["--run-dir", "--duration", "--okf-binary"].includes(args[i])) i++;
  }
  const runDir = value("--run-dir");
  if (!runDir || !isAbsolute(runDir)) throw new Error("--run-dir must be a new absolute directory");
  const smoke = args.includes("--smoke");
  const duration = value("--duration") ?? (smoke ? "4m" : "8h");
  const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(duration);
  if (!match) throw new Error("--duration needs a positive number followed by s, m, or h");
  const durationMs = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2]]!;
  if (durationMs < 10_000 || durationMs > 24 * 3_600_000)
    throw new Error("Duration must be between 10s and 24h");
  const okfBinary = value("--okf-binary");
  if (okfBinary && (!isAbsolute(okfBinary) || !existsSync(okfBinary)))
    throw new Error("--okf-binary must name an existing absolute executable");
  return { runDir, durationMs, smoke, okfBinary, injectFailure: args.includes("--inject-failure") };
}
export async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, item.name);
    if (item.isDirectory()) bytes += await directoryBytes(path);
    else if (item.isFile()) {
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      bytes += info?.size ?? 0;
    }
  }
  return bytes;
}
async function controller() {
  if (process.argv.includes("--help")) {
    console.log(
      "vp exec node tools/performance.ts --run-dir /absolute/new/directory [--duration 8h] [--smoke] [--okf-binary /absolute/irudd-okf] [--inject-failure]",
    );
    return;
  }
  await runPerformance(options());
}
export async function runPerformance(
  config: Options,
  execution: {
    workerEntrypoint?: string;
    setupTimeoutMs?: number;
    pollMs?: number;
    heartbeatTimeoutMs?: number;
  } = {},
) {
  if (process.platform !== "linux")
    throw new Error(
      "The comprehensive protocol currently requires Linux process groups and /proc safeguards.",
    );
  if (existsSync(config.runDir))
    throw new Error(
      "Run directory already exists. Select a fresh directory to preserve all previous reports.",
    );
  await mkdir(config.runDir, { recursive: true });
  for (const dir of ["tmp", "data", "logs", "home", "config", "cache"])
    await mkdir(join(config.runDir, dir));
  Object.assign(process.env, {
    LIBGL_ALWAYS_SOFTWARE: "1",
    TMPDIR: join(config.runDir, "tmp"),
    TMP: join(config.runDir, "tmp"),
    TEMP: join(config.runDir, "tmp"),
    HOME: join(config.runDir, "home"),
    XDG_CONFIG_HOME: join(config.runDir, "config"),
    XDG_CACHE_HOME: join(config.runDir, "cache"),
    XDG_DATA_HOME: join(config.runDir, "data"),
    GH_CONFIG_DIR: join(config.runDir, "config", "gh"),
    GIT_CONFIG_GLOBAL: join(config.runDir, "config", "gitconfig"),
    SCOPE_PERFORMANCE_OPTIONS: JSON.stringify(config),
  });
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SCOPE_ENDPOINT;
  delete process.env.SCOPE_TOKEN;
  delete process.env.SCOPE_TOKEN_FILE;
  delete process.env.SCOPE_CONNECTION_FILE;
  const report = new Report(config.runDir);
  const owned = new OwnedProcesses(`scope-performance-${randomUUID()}`);
  process.env.SCOPE_PERFORMANCE_MARKER = owned.marker;
  let processesStopped = false;
  report.write("environment.json", {
    ...config,
    platform: process.platform,
    arch: process.arch,
    release: release(),
    cpu: cpus(),
    memoryBytes: totalmem(),
    node: process.version,
    rendering: "GPU disabled; visible isolated Electron window on Xvfb",
    limits: {
      generatedBytes: 2 * 1024 ** 3,
      logBytes: 2 * 1024 ** 3,
      openTabs: 200,
      prompts: 1000,
      memories: 1000,
      minFreeDiskBytes: 8 * 1024 ** 3,
      minAvailableRamBytes: 512 * 1024 ** 2,
      operationMs: 30_000,
      scenarioMs: 180_000,
      cleanupMs: 70_000,
      processCloseMs: 30_000,
      processVerificationMs: 5_000,
      profileCleanupMs: 30_000,
    },
  });
  let started = performance.now(),
    deadline = started + (execution.setupTimeoutMs ?? 180_000),
    ready = false;
  let worker: ChildProcess | undefined,
    heartbeat = performance.now(),
    stopping = false,
    forced = false,
    recovery = 0,
    lowRam = 0;
  let measurementEnd: number | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (worker?.pid) {
      try {
        killProcessGroup(worker.pid, signal);
      } catch {}
    }
  };
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    measurementEnd ??= Math.min(performance.now(), deadline);
    report.event("stop", { reason });
    worker?.kill("SIGTERM");
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  try {
    while (!stopping && performance.now() < deadline) {
      const log = createWriteStream(join(config.runDir, "logs", `worker-${recovery}.log`), {
        flags: "a",
      });
      worker = spawn(
        process.execPath,
        [execution.workerEntrypoint ?? resolve("tools/performance/launch-worker.ts")],
        {
          env: {
            ...process.env,
            SCOPE_PERFORMANCE_REMAINING_MS: String(
              ready ? Math.max(0, deadline - performance.now()) : config.durationMs,
            ),
            SCOPE_PERFORMANCE_OFFSET_MS: String(ready ? performance.now() - started : 0),
            SCOPE_PERFORMANCE_ATTEMPT: String(recovery),
          },
          detached: true,
          argv0: owned.marker,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      worker.stdout!.pipe(log);
      worker.stderr!.pipe(log);
      heartbeat = performance.now();
      worker.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (("heartbeat" in message && message.heartbeat === true) ||
            ("ready" in message && message.ready === true))
        )
          heartbeat = performance.now();
        if (
          typeof message === "object" &&
          message !== null &&
          "pid" in message &&
          typeof message.pid === "number" &&
          (("detached" in message && message.detached) ||
            ("type" in message && message.type === "electron"))
        )
          owned.registerGroup(message.pid);
        if (!ready && typeof message === "object" && message !== null && "ready" in message) {
          ready = true;
          started = performance.now();
          deadline = started + config.durationMs;
          report.event("measurement-start", { durationMs: config.durationMs });
        }
      });
      let exited = false,
        code: number | null = null,
        exitedAt = 0;
      worker.on("error", (error) => {
        report.event("failure", { error: String(error) });
        exited = true;
      });
      worker.on("exit", (value) => {
        code = value;
        exitedAt = performance.now();
        exited = true;
      });
      let nextSample = 0;
      while (!exited && !stopping && performance.now() < deadline) {
        await delay(execution.pollMs ?? 1000);
        if (performance.now() - heartbeat > (execution.heartbeatTimeoutMs ?? 45_000)) {
          report.event("timeout", { reason: "Worker heartbeat stalled", recovery });
          forced = true;
          stop("watchdog");
        }
        if (performance.now() >= nextSample) {
          nextSample = performance.now() + 10_000;
          const disk = await statfs(config.runDir);
          const memory =
            process.platform === "linux" ? await readFile("/proc/meminfo", "utf8") : "";
          const available = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1] ?? Infinity) * 1024;
          lowRam = available < 512 * 1024 ** 2 ? lowRam + 1 : 0;
          const dataBytes =
            (await directoryBytes(join(config.runDir, "data"))) +
            (await directoryBytes(join(config.runDir, "tmp"))) +
            (await directoryBytes(join(config.runDir, "home"))) +
            (await directoryBytes(join(config.runDir, "cache"))) +
            (await directoryBytes(join(config.runDir, "config")));
          const logBytes = (await directoryBytes(config.runDir)) - dataBytes;
          report.event(
            "host",
            {
              controllerMemory: process.memoryUsage(),
              controllerCpuMicroseconds: process.cpuUsage(),
              freeDiskBytes: disk.bavail * disk.bsize,
              availableRamBytes: available,
              dataBytes,
              logBytes,
            },
            "resources.jsonl",
          );
          if (
            disk.bavail * disk.bsize < 8 * 1024 ** 3 ||
            lowRam >= 3 ||
            dataBytes > 2 * 1024 ** 3 ||
            logBytes > 2 * 1024 ** 3
          ) {
            report.event("safeguard", { available, dataBytes, logBytes });
            forced = true;
            stop("resource limit");
          }
          report.write("summary.json", summarize(config.runDir));
          report.write("run-state.json", {
            pid: process.pid,
            workerPid: worker.pid,
            startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
            deadlineAt: new Date(
              Date.now() + Math.max(0, deadline - performance.now()),
            ).toISOString(),
            elapsedMs: performance.now() - started,
            durationMs: config.durationMs,
            status: stopping ? "stopping" : "running",
            recovery,
          });
          report.sync();
        }
      }
      if (!exited) {
        stop(stopping ? "requested" : "deadline");
        const end = performance.now() + 30_000;
        while (!exited && performance.now() < end) await delay(250);
      }
      killGroup("SIGKILL");
      report.event("process-cleanup", await owned.terminate());
      log.end();
      if (stopping || performance.now() >= deadline || code === 0) {
        measurementEnd ??= Math.min(exitedAt || performance.now(), deadline);
        break;
      }
      recovery++;
      report.event("recovery", { attempt: recovery, code });
      if (recovery >= 2) {
        forced = true;
        measurementEnd ??= Math.min(exitedAt || performance.now(), deadline);
        break;
      }
    }
  } catch (error) {
    measurementEnd ??= Math.min(performance.now(), deadline);
    forced = true;
    report.event("failure", { operation: "controller", error: String(error) });
  } finally {
    killGroup("SIGKILL");
    try {
      report.event("process-cleanup", await owned.terminate());
      processesStopped = true;
    } catch (error) {
      forced = true;
      report.event("failure", { operation: "process-cleanup", error: String(error) });
    }
    report.event("measurement-end", {
      measuredElapsedMs: ready
        ? Math.max(0, (measurementEnd ?? Math.min(performance.now(), deadline)) - started)
        : 0,
    });
    const cleanupStart = performance.now();
    const cleanupAlarm = setTimeout(() => {
      report.event("timeout", { operation: "controller-final-cleanup", limitMs: 30_000 });
      report.write("summary.json", summarize(config.runDir));
      report.write("run-state.json", {
        status: "failed",
        reason: "Final cleanup exceeded 30 seconds",
        pid: process.pid,
      });
      report.sync();
      process.exit(1);
    }, 30_000);
    // Reports and diagnostics remain; only routine isolated state is disposable.
    for (const dir of processesStopped ? ["tmp", "data", "home", "cache", "config"] : []) {
      if (performance.now() - cleanupStart > 25_000) break;
      await rm(join(config.runDir, dir), { recursive: true, force: true, maxRetries: 0 }).catch(
        (error) => report.event("failure", { operation: "cleanup", error: String(error) }),
      );
    }
    clearTimeout(cleanupAlarm);
    report.event(
      "host",
      {
        label: "after-final-cleanup",
        controllerMemory: process.memoryUsage(),
        controllerCpu: process.cpuUsage(),
        meminfo: await readFile("/proc/meminfo", "utf8"),
      },
      "resources.jsonl",
    );
    report.event("cleanup", { durationMs: performance.now() - cleanupStart });
    const summary = summarize(config.runDir);
    const longEnough = summary.longestSessionMs >= 4 * 3_600_000;
    report.event("coverage", {
      feature: "controller.long-lived-session",
      value: {
        status:
          config.durationMs < 8 * 3_600_000 ? "unmeasured" : longEnough ? "measured" : "failed",
        reason:
          config.durationMs < 8 * 3_600_000
            ? "Short run; four-hour accumulation measurement requires the eight-hour protocol"
            : `Longest Electron session ${summary.longestSessionMs}ms; required at least 14400000ms unless a recorded failure prevented it`,
        samples: longEnough ? 1 : 0,
      },
    });
    if (ready && config.durationMs >= 8 * 3_600_000 && performance.now() >= deadline && !longEnough)
      forced = true;
    const required = rows(config.runDir, "events.jsonl").find((row) => row.type === "inventory")
      ?.required as string[] | undefined;
    const incomplete: string[] = [];
    if (!ready) incomplete.push("Measurement never began");
    if (!ready || (measurementEnd ?? 0) - started < config.durationMs)
      incomplete.push("Requested measurement duration did not complete");
    if (!required?.length) incomplete.push("Required feature inventory was not recorded");
    for (const feature of required ?? [])
      if (summary.coverage[feature]?.status !== "measured")
        incomplete.push(`Incomplete feature: ${feature}`);
    const records = rows(config.runDir, "events.jsonl");
    for (const phase of ["baseline", "mixed", "repeat-cleanup-restart"])
      if (!records.some((row) => row.type === "phase" && row.phase === phase))
        incomplete.push(`Incomplete phase: ${phase}`);
    for (const label of ["beginning", "middle", "end"])
      if (!records.some((row) => row.type === "checkpoint" && row.label === label))
        incomplete.push(`Incomplete checkpoint: ${label}`);
    if (incomplete.length) {
      forced = true;
      report.event("failure", { operation: "run-completeness", reasons: incomplete });
    }
    report.write("summary.json", summarize(config.runDir));
    report.write("run-state.json", {
      pid: process.pid,
      status: forced
        ? "failed"
        : stopping && performance.now() < deadline
          ? "interrupted"
          : "complete",
      durationMs: config.durationMs,
      elapsedMs: performance.now() - started,
      recovery,
      incomplete,
      measuredElapsedMs: ready ? Math.max(0, (measurementEnd ?? 0) - started) : 0,
      processesStopped,
    });
    report.sync();
    if (forced) process.exitCode = 1;
    console.log(
      JSON.stringify({
        runDir: config.runDir,
        summary: join(config.runDir, "summary.json"),
        elapsedMs: performance.now() - started,
      }),
    );
  }
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href)
  await controller().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
