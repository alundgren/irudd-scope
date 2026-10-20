import type { ElectronApplication, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { desktopFixture } from "../../tests/desktop-fixture.ts";
import { Report, type Coverage } from "./report.ts";

export type Metric = "interaction" | "cli" | "api" | "ipc" | "renderer" | "integration";
export class Session {
  application!: ElectronApplication;
  page!: Page;
  phase = "baseline";
  workload = "small";
  feature = "setup";
  stopping = false;
  coverage = new Map<string, Coverage>();
  operation = "idle";
  sessionStart = 0;
  private lastSample = performance.now();
  private sampling = false;
  private closePromise?: Promise<void>;
  private navigating = false;
  readonly report: Report;
  readonly fixture: Awaited<ReturnType<typeof desktopFixture>>;
  constructor(report: Report, fixture: Awaited<ReturnType<typeof desktopFixture>>) {
    this.report = report;
    this.fixture = fixture;
  }
  status(feature: string, status: Coverage["status"], reason: string) {
    const previous = this.coverage.get(feature);
    const value = {
      status,
      reason,
      samples: (previous?.samples ?? 0) + (status === "measured" ? 1 : 0),
    };
    this.coverage.set(feature, value);
    this.report.event("coverage", { feature, value });
  }
  async run<T>(operation: string, metric: Metric, action: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("Run stopped");
    const id = randomUUID();
    this.operation = operation;
    await writeFile(
      join(this.report.directory, "data", "context.json"),
      JSON.stringify({
        phase: this.phase,
        workload: this.workload,
        feature: this.feature,
        operation,
        id,
        delayMs: operation === "known-delay-sync" ? 250 : 0,
      }),
    );
    const started = performance.now();
    const timer = setTimeout(() => {
      this.report.event("timeout", {
        feature: this.feature,
        operation,
        phase: this.phase,
        workload: this.workload,
        id,
        limitMs: 30_000,
      });
      this.report.sync();
      // Exiting makes the controller kill this entire process group, including pending writes.
      process.exit(75);
    }, 30_000);
    try {
      const value = await action();
      if (metric === "interaction" && this.page && !this.page.isClosed())
        await this.page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      this.report.event("operation", {
        id,
        phase: this.phase,
        workload: this.workload,
        feature: this.feature,
        operation,
        metric,
        completionIncludesTwoAnimationFrames: metric === "interaction",
        status: "ok",
        durationMs: performance.now() - started,
      });
      return value;
    } catch (error) {
      this.report.event("operation", {
        id,
        phase: this.phase,
        workload: this.workload,
        feature: this.feature,
        operation,
        metric,
        status: "failed",
        durationMs: performance.now() - started,
        error: String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async client() {
    const connection = decodeLocalConnection(
      JSON.parse(await readFile(this.fixture.connectionFile, "utf8")),
    );
    return new ScopeClient(connection.endpoint, connection.token);
  }
  async cli(...args: string[]) {
    return this.run(args.slice(0, 2).join(" "), "cli", () =>
      this.command(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
        SCOPE_CONNECTION_FILE: this.fixture.connectionFile,
      }),
    );
  }
  async command(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        error = "";
      const stopWorker = (reason: string) => {
        this.report.event("timeout", {
          feature: this.feature,
          phase: this.phase,
          workload: this.workload,
          operation: this.operation,
          reason,
        });
        this.report.sync();
        process.exit(75);
      };
      const timer = setTimeout(() => stopWorker("Command exceeded 29 seconds"), 29_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > 2 * 1024 ** 2) stopWorker("Command output exceeded 2 MiB");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString()).slice(-8000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(`${command} exited ${code}: ${error}`));
      });
    });
  }
  async launch() {
    await this.run("launch-visible-electron", "interaction", async () => {
      this.application = await this.fixture.launch();
      this.closePromise = undefined;
      process.send?.({ type: "electron", pid: this.application.process().pid });
      this.sessionStart = performance.now();
      this.page = await this.application.firstWindow();
      this.page.setDefaultTimeout(25_000);
      this.page.setDefaultNavigationTimeout(25_000);
      await this.page.getByRole("tab").first().waitFor();
      const log = this.application.process();
      log.stderr?.on("data", (chunk: Buffer) =>
        this.report.event(
          "electron-stderr",
          { message: chunk.toString().slice(-8000) },
          "diagnostics.jsonl",
        ),
      );
      await this.installRendererProbe();
    });
    this.report.event("session", {
      event: "started",
      pid: this.application.process().pid,
      phase: this.phase,
    });
  }
  async installRendererProbe() {
    await this.page.evaluate(() => {
      const state = {
        frames: 0,
        maxFrameMs: 0,
        frameTotalMs: 0,
        lastFrame: performance.now(),
        ticks: 0,
        maxTimerLagMs: 0,
        timerTotalLagMs: 0,
        lastTick: performance.now(),
      };
      Object.assign(window, { performanceProbe: state });
      const frame = (time: number) => {
        const elapsed = time - state.lastFrame;
        state.frames++;
        state.frameTotalMs += elapsed;
        state.maxFrameMs = Math.max(state.maxFrameMs, elapsed);
        state.lastFrame = time;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - state.lastTick - 100);
        state.ticks++;
        state.maxTimerLagMs = Math.max(state.maxTimerLagMs, lag);
        state.timerTotalLagMs += lag;
        state.lastTick = now;
      }, 100);
    });
  }
  async reloadRenderer() {
    this.navigating = true;
    try {
      await this.page.reload();
      await this.page.getByRole("tab").first().waitFor();
      await this.installRendererProbe();
    } finally {
      this.navigating = false;
    }
  }
  async open(title: string) {
    await this.page.keyboard.press("Escape");
    await this.page.keyboard.press("ControlOrMeta+k");
    await this.page.getByLabel("Search artifacts", { exact: true }).fill(title);
    const button = this.page.getByRole("button", { name: title, exact: true });
    if (await button.count()) await button.click();
    else await this.page.keyboard.press("Enter");
    await this.page.getByRole("tab", { name: title, selected: true, exact: true }).waitFor();
  }
  async settle() {
    await delay(500);
    await this.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }
  async sample(label: string) {
    if (this.sampling || !this.application || this.stopping || this.closePromise || this.navigating)
      return;
    this.sampling = true;
    const timer = setTimeout(() => {
      this.report.event("timeout", { operation: "central-sampler" });
      this.report.sync();
      process.exit(75);
    }, 30_000);
    try {
      const now = performance.now();
      const metrics = await this.application.evaluate(({ app }) => app.getAppMetrics());
      const rss: Record<string, number> = {};
      if (process.platform === "linux") {
        for (const metric of metrics) {
          const status = await readFile(`/proc/${metric.pid}/status`, "utf8").catch(() => "");
          rss[metric.pid] = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
        }
      }
      const renderer = await this.page.evaluate(() => {
        const state = (
          window as unknown as {
            performanceProbe: {
              frames: number;
              maxFrameMs: number;
              frameTotalMs: number;
              ticks: number;
              maxTimerLagMs: number;
              timerTotalLagMs: number;
            };
          }
        ).performanceProbe;
        if (!state) return { unavailableReason: "Renderer navigation" };
        const result = {
          ...state,
          selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
          visibility: document.visibilityState,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        };
        state.frames = 0;
        state.maxFrameMs = 0;
        state.frameTotalMs = 0;
        state.ticks = 0;
        state.maxTimerLagMs = 0;
        state.timerTotalLagMs = 0;
        return result;
      });
      const databases: Record<string, number> = {};
      for (const path of [
        join(this.fixture.settingsDirectory, "desktop.db"),
        join(this.fixture.settingsDirectory, "artifacts", "scope.db"),
        join(
          this.report.directory,
          "data",
          `hub-${process.env.SCOPE_PERFORMANCE_ATTEMPT ?? "0"}`,
          "hub",
          "hub.db",
        ),
      ]) {
        for (const suffix of ["", "-wal", "-shm"])
          databases[path.replace(this.report.directory, "run") + suffix] =
            (await stat(path + suffix).catch(() => undefined))?.size ?? 0;
      }
      this.report.event(
        "sample",
        {
          label,
          phase: this.phase,
          workload: this.workload,
          feature: this.feature,
          operation: this.operation,
          intervalMs: now - this.lastSample,
          sessionAgeMs: now - this.sessionStart,
          processes: metrics.map((metric) => ({ ...metric, rssBytes: rss[metric.pid] ?? null })),
          renderer,
          databases,
        },
        "resources.jsonl",
      );
      this.lastSample = now;
    } finally {
      clearTimeout(timer);
      this.sampling = false;
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (!this.application) return Promise.resolve();
    const application = this.application;
    this.report.event("session", {
      event: "closing",
      pid: application.process().pid,
      ageMs: performance.now() - this.sessionStart,
      phase: this.phase,
    });
    this.closePromise = application.close();
    return this.closePromise;
  }
}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const end = performance.now() + 28_000;
  while (performance.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw new Error("Observable completion was not reached within 28 seconds");
}
