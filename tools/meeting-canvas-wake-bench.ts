/**
 * Replays wake-word meeting transcripts through the Meeting canvas edit backend.
 *
 *   vp exec node tools/meeting-canvas-wake-bench.ts --sets <dir>[,<dir>] --out <dir>
 *     [--only slug,slug] [--skip slug,slug] [--parallel 3] [--usage-cmd "<command>"] [--stop-at 88]
 *
 * Each set folder holds `<slug>.txt` transcripts (`Name: text` per chunk, blank line = pause,
 * `#` = header). Speaker names are stripped before wake detection, as the app has none.
 * Writes `<slug>.json` (every request with timings, ops and canvas snapshots) and
 * `<slug>.replay.html` to --out, which must be outside the repository.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  codexEdit,
  parseEditReply,
  resolveCodex,
} from "../apps/desktop/src/plugins/meeting/backends.ts";
import { applyCanvasOps, emptyCanvas } from "../apps/desktop/src/plugins/meeting/canvas.ts";
import type { Canvas, CanvasOp } from "../apps/desktop/src/plugins/meeting/contract.ts";
import { buildCanvasMessage, SYSTEM_PROMPT } from "../apps/desktop/src/plugins/meeting/prompt.ts";
import { renderCanvas } from "../apps/desktop/src/plugins/meeting/render.ts";
import {
  stripSpeakerLabel,
  WakeDetector,
  type WakeRequest,
} from "../apps/desktop/src/plugins/meeting/wake.ts";
import { wakeReplayHtml } from "./meeting-canvas-wake-replay.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const meeting = join(root, "apps", "desktop", "src", "plugins", "meeting");
const run = promisify(execFile);
const WORDS_PER_SECOND = 2.5;
const CLIP_CAP_S = 6;
const RECENT_LINES = 30;
const CANCEL_WINDOW_MS = 5_000;

type Chunk = {
  /** 1-based line number in the transcript file. */
  line: number;
  speaker: string;
  text: string;
  start: number;
  end: number;
  gapMs: number;
};
export type BenchRequest = {
  action: WakeRequest["action"];
  text: string;
  /** File line numbers of the chunks the request came from, wake chunk first. */
  lines: number[];
  /** Simulated time when the request was sent and when its result appeared, in seconds. */
  sentAt: number;
  doneAt: number;
  ms?: number;
  ops?: readonly CanvasOp[];
  rejected?: { op: CanvasOp; reason: string }[];
  changed?: string[];
  created?: string[];
  canvas: Canvas;
  error?: string;
};

function options() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const known = ["--sets", "--out", "--only", "--skip", "--parallel", "--usage-cmd", "--stop-at"];
  for (let i = 0; i < args.length; i += 2) {
    if (!known.includes(args[i]!)) throw new Error(`Unknown argument ${args[i]}`);
    if (args[i + 1] === undefined) throw new Error(`Missing ${args[i]} value`);
    values.set(args[i]!, args[i + 1]!);
  }
  const out = values.get("--out");
  const sets = values.get("--sets");
  if (!out || !sets) throw new Error("Pass --sets <dir> and --out <dir>.");
  const directory = resolve(out);
  const inside = relative(root, directory);
  if (!inside.startsWith("..") && !inside.startsWith(sep) && inside !== directory)
    throw new Error("--out must be outside the repository.");
  const list = (name: string) =>
    values
      .get(name)
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    directory,
    sets: list("--sets")!.map((set) => resolve(set)),
    only: list("--only"),
    skip: list("--skip") ?? [],
    parallel: Math.max(1, Number(values.get("--parallel") ?? 3)),
    usageCmd: values.get("--usage-cmd"),
    stopAt: Number(values.get("--stop-at") ?? 88),
  };
}

/** Parses a transcript into timed chunks, as the microphone would deliver them. */
export function chunks(script: string): Chunk[] {
  const result: Chunk[] = [];
  let clock = 0;
  let pause = false;
  script.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith("#")) return;
    if (!line) {
      pause = true;
      return;
    }
    const text = stripSpeakerLabel(line);
    const speaker =
      text === line ? "" : line.slice(0, line.length - text.length).replace(/:\s*$/, "");
    const words = text.split(/\s+/).filter(Boolean).length;
    const gap = pause ? 2 : 0.35;
    const start = clock + gap;
    const end = start + Math.min(CLIP_CAP_S, Math.max(0.8, words / WORDS_PER_SECOND));
    result.push({ line: index + 1, speaker, text, start, end, gapMs: gap * 1000 });
    clock = end;
    pause = false;
  });
  return result;
}

async function usedPercent(command: string | undefined) {
  if (!command) return 0;
  const { stdout } = await run("/bin/sh", ["-c", command], { timeout: 60_000 });
  return Number(stdout.trim());
}

async function replay(
  slug: string,
  script: string,
  codexPath: string,
  budget: { calls: number; check: () => Promise<boolean> },
) {
  const timed = chunks(script);
  const detector = new WakeDetector();
  let canvas: Canvas = emptyCanvas();
  let focus: string | null = null;
  const history: { canvas: Canvas; at: number }[] = [];
  const requests: BenchRequest[] = [];
  let busyUntil = 0;
  const heard: string[] = [];

  const handle = async (request: WakeRequest, now: number) => {
    const lines = request.chunks.map((index) => timed[index]!.line);
    const sentAt = Math.max(now, busyUntil);
    if (request.action === "undo" || request.action === "cancel") {
      const last = history.at(-1);
      const recent =
        last && (request.action === "undo" || (sentAt - last.at) * 1000 <= CANCEL_WINDOW_MS);
      if (last && recent) {
        canvas = last.canvas;
        history.pop();
      }
      requests.push({
        action: request.action,
        text: request.text,
        lines,
        sentAt,
        doneAt: sentAt,
        canvas,
      });
      return;
    }
    if (!(await budget.check())) throw new Error("Codex budget limit reached.");
    budget.calls++;
    const entry: BenchRequest = {
      action: "model",
      text: request.text,
      lines,
      sentAt,
      doneAt: sentAt,
      canvas,
    };
    try {
      const user = buildCanvasMessage({
        canvas,
        request: request.text,
        recent: heard.slice(-RECENT_LINES),
        focus,
      });
      const reply = await codexEdit({ codexPath, system: SYSTEM_PROMPT, user });
      const { ops } = parseEditReply(reply.content);
      const result = applyCanvasOps(canvas, ops, focus);
      history.push({ canvas, at: sentAt + reply.ms / 1000 });
      canvas = result.canvas;
      focus = result.changed.at(-1) ?? focus;
      Object.assign(entry, {
        ms: reply.ms,
        ops,
        rejected: result.rejected,
        changed: result.changed,
        created: result.created,
        canvas,
        doneAt: sentAt + reply.ms / 1000,
      });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.doneAt = sentAt + 1;
    }
    busyUntil = entry.doneAt;
    requests.push(entry);
  };

  for (const [index, chunk] of timed.entries()) {
    // Before this chunk arrives the room was quiet for its gap; let a pending request go.
    for (const request of detector.tick(chunk.start * 1000 - 1, false))
      await handle(request, chunk.start);
    for (const request of detector.push(chunk.text, {
      endedBy: chunk.end - chunk.start >= CLIP_CAP_S ? "cap" : "silence",
      gapMs: chunk.gapMs,
      endedAt: chunk.end * 1000,
    }))
      await handle(request, chunk.end);
    heard.push(chunk.text);
    void index;
  }
  const end = (timed.at(-1)?.end ?? 0) + 10;
  for (const request of detector.tick(end * 1000, false)) await handle(request, end);
  for (const request of detector.flush()) await handle(request, end);
  return { slug, chunks: timed, requests, canvas };
}

async function main() {
  const { directory, sets, only, skip, parallel, usageCmd, stopAt } = options();
  const codexPath = await resolveCodex("");
  const require = createRequire(join(root, "apps", "desktop", "package.json"));
  const css = [
    await readFile(require.resolve("katex/dist/katex.min.css"), "utf8"),
    await readFile(join(meeting, "page.css"), "utf8"),
    await readFile(join(meeting, "canvas.css"), "utf8"),
  ].join("\n");
  const scripts: { slug: string; file: string }[] = [];
  for (const set of sets)
    for (const file of (await readdir(set)).filter((name) => name.endsWith(".txt")).sort()) {
      const slug = basename(file, ".txt");
      if ((only && !only.includes(slug)) || skip.includes(slug)) continue;
      scripts.push({ slug, file: join(set, file) });
    }
  await mkdir(directory, { recursive: true });
  let stopped = false;
  let lastCheck = 0;
  const budget = {
    calls: 0,
    async check() {
      if (stopped) return false;
      if (budget.calls - lastCheck < 20 && lastCheck !== 0) return true;
      lastCheck = Math.max(1, budget.calls);
      const used = await usedPercent(usageCmd);
      console.error(`usage ${used}% after ${budget.calls} calls`);
      if (used >= stopAt) stopped = true;
      return !stopped;
    },
  };
  const queue = [...scripts];
  const summary: string[] = [];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (let next = queue.shift(); next && !stopped; next = queue.shift()) {
        const script = await readFile(next.file, "utf8");
        try {
          const result = await replay(next.slug, script, codexPath, budget);
          await writeFile(
            join(directory, `${next.slug}.json`),
            `${JSON.stringify(result, null, 1)}\n`,
          );
          await writeFile(
            join(directory, `${next.slug}.replay.html`),
            wakeReplayHtml({ title: next.slug, css, result, render: renderCanvas }),
          );
          const model = result.requests.filter((request) => request.action === "model");
          summary.push(
            `${next.slug}: ${result.requests.length} requests, ${model.filter((request) => request.error).length} errors, ${result.canvas.sections.length} sections`,
          );
          console.error(`done ${next.slug}`);
        } catch (error) {
          console.error(`failed ${next.slug}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }),
  );
  console.log(summary.sort().join("\n"));
  console.log(
    `\n${budget.calls} model calls${stopped ? ", stopped at the usage limit" : ""}. Output: ${directory}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
