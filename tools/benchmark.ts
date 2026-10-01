import { type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { desktopFixture } from "../tests/desktop-fixture.ts";

const exec = promisify(execFile);
const sampleCount = 5;
const cpuSampleSeconds = 3;
const largeMarkdownBytes = 1024 * 1024;
const largeBinaryBytes = 16 * 1024 * 1024;
const extraTabCount = 20;
const kinds = ["text", "markdown", "html", "image", "file", "excalidraw"] as const;
type Kind = (typeof kinds)[number];

type ProcessMetric = {
  pid: number;
  creationTime: number;
  type: string;
  cpu: { percentCPUUsage: number; cumulativeCPUUsage?: number };
  memory: { workingSetSize: number };
};

type ProcessRow = { pid: number; ppid: number; rssKb: number };

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw8sAAAAASUVORK5CYII=",
  "base64",
);

function excalidrawContent() {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "scope-benchmark",
    elements: [
      {
        type: "rectangle",
        id: "benchmark-box",
        x: 30,
        y: 30,
        width: 220,
        height: 100,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "#a5d8ff",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

function markdownContent(bytes: number, heading = "Large benchmark note") {
  const line = "A short synthetic paragraph for renderer timing.\n\n";
  const repetitions = Math.ceil(bytes / Buffer.byteLength(line));
  return `# ${heading}\n\n${line.repeat(repetitions)}`.slice(0, bytes);
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: samples.length,
    min: samples.length ? sorted[0] : null,
    median: samples.length ? percentile(0.5) : null,
    p90: samples.length ? percentile(0.9) : null,
    max: samples.length ? sorted[sorted.length - 1] : null,
  };
}

function artifactFile(kind: Kind) {
  switch (kind) {
    case "text":
      return { extension: "txt", content: "A compact plain text note for Scope benchmarking.\n" };
    case "markdown":
      return {
        extension: "md",
        content:
          "# Markdown benchmark\n\nA **formatted** note with one [link](https://example.invalid).\n",
      };
    case "html":
      return {
        extension: "html",
        content: "<h1>HTML benchmark</h1><p>Local synthetic preview.</p>",
      };
    case "image":
      return { extension: "png", content: png };
    case "file":
      return { extension: "bin", content: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) };
    case "excalidraw":
      return { extension: "excalidraw", content: excalidrawContent() };
  }
}

async function writeKindFiles(directory: string) {
  const paths = new Map<Kind, string>();
  for (const kind of kinds) {
    const file = artifactFile(kind);
    const path = join(directory, `sample.${file.extension}`);
    await writeFile(path, file.content);
    paths.set(kind, path);
  }
  const largePath = join(directory, "large-note.md");
  await writeFile(largePath, markdownContent(largeMarkdownBytes));
  return { paths, largePath };
}

async function runCli(fixture: Awaited<ReturnType<typeof desktopFixture>>, args: string[]) {
  const started = performance.now();
  const result = await fixture.cli(...args);
  return { elapsedMs: performance.now() - started, artifact: JSON.parse(result.stdout) };
}

async function openArtifact(
  page: Page,
  title: string,
  kind: Kind,
  options: { heading?: string; fileName?: string } = {},
) {
  const started = performance.now();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByLabel("Search artifacts", { exact: true }).fill(title);
  await page.keyboard.press("Enter");
  const pane = page.getByRole("tabpanel", { name: title, exact: true });
  await pane.waitFor({ state: "visible" });
  switch (kind) {
    case "text":
      await pane.locator("pre").waitFor({ state: "visible" });
      break;
    case "markdown":
      await pane
        .getByRole("heading", { name: options.heading ?? "Markdown benchmark", exact: true })
        .waitFor();
      break;
    case "html":
      await pane.frameLocator("iframe").getByRole("heading", { name: "HTML benchmark" }).waitFor();
      break;
    case "image":
      await pane.getByRole("img").evaluate(async (image) => {
        const element = image as HTMLImageElement;
        if (element.complete && element.naturalWidth > 0) return;
        await new Promise<void>((resolveImage, rejectImage) => {
          element.addEventListener("load", () => resolveImage(), { once: true });
          element.addEventListener("error", () => rejectImage(new Error("Image failed to load.")), {
            once: true,
          });
        });
      });
      break;
    case "file":
      await pane
        .getByRole("heading", { name: options.fileName ?? "sample.bin", exact: true })
        .waitFor();
      break;
    case "excalidraw":
      await pane.locator(".excalidraw canvas").first().waitFor({ state: "visible" });
      break;
  }
  return { elapsedMs: performance.now() - started, pane };
}

async function processRows(): Promise<ProcessRow[]> {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((values) => values.length === 3 && values.every(Number.isFinite))
    .map(([pid, ppid, rssKb]) => ({ pid, ppid, rssKb }));
}

function descendants(rows: ProcessRow[], rootPid: number) {
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return [...pids];
}

async function sampleProcessState(application: ElectronApplication, seconds: number) {
  const first = (await application.evaluate(({ app }) => {
    const metrics = app.getAppMetrics();
    return {
      pid: metrics.find((metric) => metric.type === "Browser")?.pid,
      metrics,
    };
  })) as { pid?: number; metrics: ProcessMetric[] };
  if (!first.pid) throw new Error("Could not identify the Electron main process.");
  const cpuSamples: Array<{
    at: string;
    singleCorePercent: number | null;
    reportedPercentByType: Record<string, number>;
    memoryByProcess: Array<{ pid: number; type: string; workingSetMb: number }>;
    processCount: number;
  }> = [];
  const rssSamples: Array<{ at: string; processCount: number; rssKb: number }> = [];
  const initialMemoryByProcess = first.metrics.map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    workingSetMb: metric.memory.workingSetSize / 1024,
  }));
  let previousMetrics = first.metrics;
  let previousAt = performance.now();
  for (let index = 0; index < seconds; index++) {
    await new Promise((done) => setTimeout(done, 1000));
    const metrics = (await application.evaluate(({ app }) =>
      app.getAppMetrics(),
    )) as ProcessMetric[];
    const elapsedSeconds = (performance.now() - previousAt) / 1000;
    previousAt = performance.now();
    const reportedPercentByType: Record<string, number> = {};
    for (const metric of metrics) {
      reportedPercentByType[metric.type] =
        (reportedPercentByType[metric.type] ?? 0) + metric.cpu.percentCPUUsage;
    }
    const previousByProcess = new Map(
      previousMetrics.map((metric) => [
        `${metric.pid}:${metric.creationTime}`,
        metric.cpu.cumulativeCPUUsage,
      ]),
    );
    let cpuSeconds = 0;
    let hasCpuDeltas = false;
    for (const metric of metrics) {
      const key = `${metric.pid}:${metric.creationTime}`;
      const before = previousByProcess.get(key);
      const after = metric.cpu.cumulativeCPUUsage;
      if (before !== undefined && after !== undefined) {
        cpuSeconds += Math.max(0, after - before);
        hasCpuDeltas = true;
      }
    }
    cpuSamples.push({
      at: new Date().toISOString(),
      singleCorePercent: hasCpuDeltas ? (cpuSeconds / elapsedSeconds) * 100 : null,
      reportedPercentByType,
      memoryByProcess: metrics.map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        workingSetMb: metric.memory.workingSetSize / 1024,
      })),
      processCount: metrics.length,
    });
    previousMetrics = metrics;
    const rows = await processRows();
    const pids = descendants(rows, first.pid);
    rssSamples.push({
      at: new Date().toISOString(),
      processCount: pids.length,
      rssKb: rows.filter((row) => pids.includes(row.pid)).reduce((sum, row) => sum + row.rssKb, 0),
    });
  }
  const totalCpu = cpuSamples.map((sample) => sample.singleCorePercent);
  const availableCpu = totalCpu.filter((sample): sample is number => sample !== null);
  // Per-process RSS includes resident shared pages in each process, so this total can overcount physical memory.
  const totalRssMb = rssSamples.map((sample) => sample.rssKb / 1024);
  return {
    sampleSeconds: seconds,
    electronProcessCount: first.metrics.length,
    electronMemoryByProcess: initialMemoryByProcess,
    electronWorkingSetMb:
      first.metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024,
    cpuPercent: {
      samples: totalCpu,
      unavailableCount: totalCpu.length - availableCpu.length,
      method:
        "100 * sum of per-process cumulativeCPUUsage deltas / elapsed seconds; percentages are one fully used logical core per 100.",
      samplesByProcessType: cpuSamples,
      summary: summarize(availableCpu),
    },
    processTreeRssMb: {
      samples: totalRssMb,
      processCounts: rssSamples.map((sample) => sample.processCount),
      summary: summarize(totalRssMb),
    },
  };
}

async function launchMeasurement(fixture: Awaited<ReturnType<typeof desktopFixture>>) {
  const started = performance.now();
  const application = await fixture.launch();
  const windowReadyMs = performance.now() - started;
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
    const emptyRenderMs = performance.now() - started;
    return { application, page, windowReadyMs, emptyRenderMs };
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
}

async function waitForText(page: Page, title: string, expected: string) {
  await page
    .getByRole("tabpanel", { name: title, exact: true })
    .locator("pre")
    .evaluate(async (element, marker) => {
      await new Promise<void>((resolveText, rejectText) => {
        const deadline = Date.now() + 15_000;
        const check = () => {
          if (element.textContent?.includes(marker)) return resolveText();
          if (Date.now() >= deadline)
            return rejectText(new Error(`Timed out waiting for ${marker}.`));
          setTimeout(check, 25);
        };
        check();
      });
    }, expected);
}

async function main() {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputArg = process.argv.findIndex((value) => value === "--output");
  const output =
    outputArg === -1
      ? join(tmpdir(), `scope-benchmark-${timestamp}.json`)
      : resolve(process.argv[outputArg + 1]);
  const gpuEnabled = process.argv.includes("--gpu");
  const fixture = await desktopFixture({ disableGpu: !gpuEnabled });
  const scratch = await mkdtemp(join(tmpdir(), "scope-benchmark-content-"));
  const { paths, largePath } = await writeKindFiles(scratch);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    outputPath: output,
    conditions: {
      repeatCount: sampleCount,
      cpuSampleSeconds,
      largeMarkdownBytes,
      largeBinaryBytes,
      extraTabCount,
      gpuEnabled,
      appArgs: ["apps/desktop", ...(gpuEnabled ? [] : ["--disable-gpu"])],
      isolatedProfile: true,
      liveProviderCalls: false,
    },
    definitions: {
      cliLatency:
        "Monotonic wall time around one built CLI process, including process startup, provenance lookup, local HTTP request, and JSON output.",
      windowReady:
        "Time from before fixture launch until Playwright receives the first Electron window.",
      firstRender:
        "Time from before fixture launch or a UI open action until the kind-specific visible content check completes.",
      cpuPercent:
        "100 times the sum of Electron app.getAppMetrics cumulativeCPUUsage deltas divided by actual sample seconds. Electron documents cumulativeCPUUsage in CPU seconds, so 100 means one fully used logical core. Raw Electron-reported percentCPUUsage values are retained by process type as supporting data.",
      processTreeRss:
        "Sum of ps RSS in KiB for the Electron main process and its OS child processes, sampled once per second. This sum can count shared pages in multiple processes.",
      tabCpuContext:
        "Each single-kind tab sample selects one tab while the other five kind tabs remain open and mounted.",
    },
  };

  let application: ElectronApplication | undefined;
  try {
    const launches: Array<{ windowReadyMs: number; emptyRenderMs: number }> = [];
    let page: Page | undefined;
    for (let index = 0; index < 3; index++) {
      const launched = await launchMeasurement(fixture);
      application = launched.application;
      page = launched.page;
      launched.page.setDefaultTimeout(15_000);
      launches.push({
        windowReadyMs: launched.windowReadyMs,
        emptyRenderMs: launched.emptyRenderMs,
      });
      if (index < 2) {
        await application.close();
        application = undefined;
      }
    }
    const startup = {
      samples: launches,
      windowReadyMs: summarize(launches.map((sample) => sample.windowReadyMs)),
      emptyRenderMs: summarize(launches.map((sample) => sample.emptyRenderMs)),
    };
    const activeApplication = application;
    const activePage = page;
    if (!activeApplication || !activePage)
      throw new Error("Electron did not finish its startup samples.");

    const emptyIdle = await sampleProcessState(activeApplication, cpuSampleSeconds);

    const cliByKind: Record<string, unknown> = {};
    const artifactTitles = new Map<Kind, string>();
    for (const kind of kinds) {
      const samples: number[] = [];
      for (let index = 0; index < sampleCount; index++) {
        const id = `bench-${kind}-${index}`;
        const title = `Benchmark ${kind} ${index}`;
        const args =
          kind === "text" || kind === "markdown"
            ? [
                "text",
                artifactFile(kind).content as string,
                "--kind",
                kind,
                "--title",
                title,
                "--id",
                id,
              ]
            : ["add", paths.get(kind)!, "--title", title, "--id", id];
        const result = await runCli(fixture, args);
        samples.push(result.elapsedMs);
        if (index === 0) artifactTitles.set(kind, title);
      }
      cliByKind[kind] = { createSamplesMs: samples, createSummaryMs: summarize(samples) };
    }

    const smallUpdatePath = paths.get("text")!;
    const updateSamples: Record<string, number[]> = { smallText: [], largeMarkdown: [] };
    for (let index = 0; index < sampleCount; index++) {
      const result = await runCli(fixture, ["update", "bench-text-0", smallUpdatePath]);
      updateSamples.smallText.push(result.elapsedMs);
    }
    const largeTitle = "Benchmark large markdown";
    const largeCreate = await runCli(fixture, [
      "add",
      largePath,
      "--title",
      largeTitle,
      "--id",
      "bench-large-markdown",
    ]);
    const largeCliCreateMs = largeCreate.elapsedMs;
    for (let index = 0; index < sampleCount; index++) {
      const result = await runCli(fixture, ["update", "bench-large-markdown", largePath]);
      updateSamples.largeMarkdown.push(result.elapsedMs);
    }
    report.cli = {
      byKind: cliByKind,
      updates: Object.fromEntries(
        Object.entries(updateSamples).map(([name, samples]) => [
          name,
          { samplesMs: samples, summaryMs: summarize(samples) },
        ]),
      ),
      largeMarkdownCreateMs: largeCliCreateMs,
    };

    const renderSamples: Record<string, number> = {};
    for (const kind of kinds) {
      const title = artifactTitles.get(kind)!;
      const result = await openArtifact(activePage, title, kind);
      renderSamples[kind] = result.elapsedMs;
    }

    const selectedTabStates: Record<string, unknown> = {};
    for (const kind of kinds) {
      const title = artifactTitles.get(kind)!;
      await openArtifact(activePage, title, kind);
      selectedTabStates[kind] = await sampleProcessState(activeApplication, cpuSampleSeconds);
    }

    const bigRender = await openArtifact(activePage, largeTitle, "markdown", {
      heading: "Large benchmark note",
    });
    const bigState = await sampleProcessState(activeApplication, cpuSampleSeconds);
    const largeUpdateSamples: Array<{ cliMs: number; visibleMs: number; marker: string }> = [];
    for (let index = 0; index < sampleCount; index++) {
      const marker = `Large update ${index}`;
      await writeFile(largePath, markdownContent(largeMarkdownBytes, marker));
      const updateStarted = performance.now();
      const result = await runCli(fixture, ["update", "bench-large-markdown", largePath]);
      await activePage.getByRole("heading", { name: marker, exact: true }).waitFor();
      largeUpdateSamples.push({
        cliMs: result.elapsedMs,
        visibleMs: performance.now() - updateStarted,
        marker,
      });
    }

    const textUpdateSamples: Array<{ cliMs: number; visibleMs: number; marker: string }> = [];
    const textTitle = artifactTitles.get("text")!;
    await openArtifact(activePage, textTitle, "text");
    for (let index = 0; index < sampleCount; index++) {
      const marker = `Small text update ${index}`;
      const path = join(scratch, `small-update-${index}.txt`);
      await writeFile(path, `${marker}\n`);
      const updateStarted = performance.now();
      const result = await runCli(fixture, ["update", "bench-text-0", path]);
      await waitForText(activePage, textTitle, marker);
      textUpdateSamples.push({
        cliMs: result.elapsedMs,
        visibleMs: performance.now() - updateStarted,
        marker,
      });
    }

    const largeBinaryPath = join(scratch, "large.bin");
    await writeFile(largeBinaryPath, Buffer.alloc(largeBinaryBytes, 0x61));
    const beforeLargeBinary = await sampleProcessState(activeApplication, cpuSampleSeconds);
    const binaryCreate = await runCli(fixture, [
      "add",
      largeBinaryPath,
      "--title",
      "Benchmark large binary",
      "--id",
      "bench-large-binary",
    ]);
    const binaryRender = await openArtifact(activePage, "Benchmark large binary", "file", {
      fileName: "large.bin",
    });
    const largeBinaryState = await sampleProcessState(activeApplication, cpuSampleSeconds);

    const extraTabs: Array<{ title: string; id: string }> = [];
    for (let index = 0; index < extraTabCount; index++) {
      const title = `Benchmark extra ${index}`;
      const id = `bench-extra-${index}`;
      await runCli(fixture, [
        "text",
        `Small synthetic tab ${index}.`,
        "--title",
        title,
        "--id",
        id,
      ]);
      extraTabs.push({ title, id });
      await openArtifact(activePage, title, "text");
    }
    const manyTabsState = await sampleProcessState(activeApplication, cpuSampleSeconds);
    const openTabCount = (await activePage.evaluate(() => window.scope.workspace()))!.tabs.length;

    await activeApplication.close();
    application = undefined;
    const reopenStarted = performance.now();
    const reopened = await fixture.launch();
    application = reopened;
    const reopenedPage = await reopened.firstWindow();
    reopenedPage.setDefaultTimeout(15_000);
    await reopenedPage.getByRole("tab").first().waitFor();
    await reopenedPage
      .getByRole("tabpanel", { name: extraTabs.at(-1)!.title, exact: true })
      .locator("pre")
      .waitFor({ state: "visible" });
    const restoredTabCount = (await reopenedPage.evaluate(() => window.scope.workspace()))!.tabs
      .length;
    const restoredRenderMs = performance.now() - reopenStarted;
    const restoredState = await sampleProcessState(reopened, cpuSampleSeconds);

    report.startup = startup;
    report.firstRenderMs = renderSamples;
    report.cpuAndMemory = {
      emptyWorkspaceIdle: emptyIdle,
      selectedTab: selectedTabStates,
      largeMarkdown: {
        bytes: largeMarkdownBytes,
        openToRenderMs: bigRender.elapsedMs,
        afterRender: bigState,
        updates: largeUpdateSamples,
      },
      largeBinary: {
        bytes: largeBinaryBytes,
        cliCreateMs: binaryCreate.elapsedMs,
        openToRenderMs: binaryRender.elapsedMs,
        beforeOpen: beforeLargeBinary,
        afterOpen: largeBinaryState,
      },
      smallTextUpdates: textUpdateSamples,
      manyTabs: { requestedExtraTabs: extraTabCount, openTabCount, state: manyTabsState },
      closeAndReopen: {
        startupToFirstRestoredTabMs: restoredRenderMs,
        restoredTabCount,
        state: restoredState,
      },
    };
    report.environment = await reopened.evaluate(({ app }) => ({
      platform: process.platform,
      architecture: process.arch,
      electronNodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      appVersion: app.getVersion(),
    }));
    report.environment = {
      ...(report.environment as Record<string, unknown>),
      hostNodeVersion: process.version,
      osRelease: release(),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
    };
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          output,
          startup: report.startup,
          firstRenderMs: report.firstRenderMs,
          cli: report.cli,
          manyTabs: { openTabCount, rssMedianMb: manyTabsState.processTreeRssMb.summary.median },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
