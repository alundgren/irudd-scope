// Replays scripted meeting transcripts through the Meeting canvas edit backends and writes the
// resulting pages and call timings outside the repository. Prototype tool for the test build.
//
//   vp exec node tools/meeting-canvas-bench.ts --out <dir> [--backend openrouter|codex|all]
//     [--models a,b]
//
// The OpenRouter key comes only from the OPENROUTER_API_KEY environment variable.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_MODEL,
  type EditOp,
  OPENROUTER_EDIT_MODELS,
  type Page,
} from "../apps/desktop/src/plugins/meeting/contract.ts";
import {
  codexEdit,
  openRouterEdit,
  parseEditReply,
  resolveCodex,
} from "../apps/desktop/src/plugins/meeting/backends.ts";
import { standaloneHtml } from "../apps/desktop/src/plugins/meeting/export.ts";
import { replayHtml, type ReplayStep } from "./meeting-canvas-replay.ts";
import { applyOps, emptyPage } from "../apps/desktop/src/plugins/meeting/page.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "../apps/desktop/src/plugins/meeting/prompt.ts";
import { renderPage } from "../apps/desktop/src/plugins/meeting/render.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scripts = join(root, "tools", "meeting-canvas-bench");
const meeting = join(root, "apps", "desktop", "src", "plugins", "meeting");
// The same pacing as the app's listening loop.
const MIN_FRESH_WORDS = 12;
const CONTEXT_LINES = 40;

type Target = { backend: "openrouter" | "codex"; model: string };
type Call = {
  batch: number;
  fresh: string[];
  requestChars: number;
  ms?: number;
  ops?: readonly EditOp[];
  applied?: number;
  rejected?: { op: EditOp; reason: string }[];
  error?: string;
};

function options() {
  const args = process.argv.slice(2);
  const known = new Set(["--out", "--backend", "--models", "--scripts"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!known.has(args[i])) throw new Error(`Unknown argument ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing ${args[i]} value`);
    values.set(args[i], args[i + 1]);
  }
  const out = values.get("--out");
  if (!out) throw new Error("Pass --out <dir> outside the repository.");
  const directory = resolve(out);
  const inside = relative(root, directory);
  if (!inside.startsWith("..") && !inside.startsWith(sep) && inside !== directory)
    throw new Error("--out must be outside the repository.");
  const backend = values.get("--backend") ?? "all";
  if (!["openrouter", "codex", "all"].includes(backend))
    throw new Error("--backend must be openrouter, codex or all.");
  const models = values
    .get("--models")
    ?.split(",")
    .map((model) => model.trim())
    .filter(Boolean) ?? [...OPENROUTER_EDIT_MODELS];
  const scriptDirectory = resolve(values.get("--scripts") ?? scripts);
  return { directory, backend, models, scriptDirectory };
}

/** Splits a script into the batches the app would send: at 12 fresh words, or at a blank line. */
function batches(script: string) {
  const result: string[][] = [];
  let fresh: string[] = [];
  const flush = () => {
    if (fresh.length) result.push(fresh);
    fresh = [];
  };
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (!line) {
      flush();
      continue;
    }
    fresh.push(line);
    if (fresh.join(" ").split(/\s+/).length >= MIN_FRESH_WORDS) flush();
  }
  flush();
  return result;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

async function run(target: Target, script: string, key: string, codexPath: string) {
  let page: Page = emptyPage();
  const heard: string[] = [];
  const calls: Call[] = [];
  const steps: ReplayStep[] = [];
  for (const [index, fresh] of batches(script).entries()) {
    const user = buildUserMessage({
      page,
      context: heard.slice(-CONTEXT_LINES),
      fresh,
      request: null,
    });
    const call: Call = {
      batch: index + 1,
      fresh,
      requestChars: SYSTEM_PROMPT.length + user.length,
    };
    try {
      const reply =
        target.backend === "codex"
          ? await codexEdit({ codexPath, system: SYSTEM_PROMPT, user })
          : await openRouterEdit({ key, model: target.model, system: SYSTEM_PROMPT, user });
      const { ops } = parseEditReply(reply.content);
      const result = applyOps(page, ops);
      page = result.page;
      Object.assign(call, {
        ms: reply.ms,
        ops,
        applied: ops.length - result.rejected.length,
        rejected: result.rejected,
      });
      steps.push({ fresh, pageHtml: renderPage(page), changed: result.changed, ...counts(call) });
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      steps.push({ fresh, pageHtml: renderPage(page), changed: [], error: call.error });
    }
    calls.push(call);
    heard.push(...fresh);
  }
  return { page, calls, steps };
}

const counts = (call: Call) => ({
  ms: call.ms,
  applied: call.applied,
  rejected: call.rejected?.length,
});

async function main() {
  const { directory, backend, models, scriptDirectory } = options();
  const key = process.env.OPENROUTER_API_KEY ?? "";
  const targets: Target[] = [];
  if (backend !== "codex") {
    if (!key) throw new Error("Set OPENROUTER_API_KEY to bench OpenRouter models.");
    targets.push(...models.map((model) => ({ backend: "openrouter" as const, model })));
  }
  const codexPath = backend === "openrouter" ? "" : await resolveCodex("");
  if (backend !== "openrouter") targets.push({ backend: "codex", model: CODEX_MODEL });
  const require = createRequire(join(root, "apps", "desktop", "package.json"));
  const css = [
    await readFile(require.resolve("katex/dist/katex.min.css"), "utf8"),
    await readFile(join(meeting, "page.css"), "utf8"),
  ].join("\n");
  const files = (await readdir(scriptDirectory)).filter((file) => file.endsWith(".txt")).sort();
  const rows: string[][] = [];
  await Promise.all(
    targets.map(async (target) => {
      for (const file of files) {
        const scenario = basename(file, ".txt");
        const script = await readFile(join(scriptDirectory, file), "utf8");
        const { page, calls, steps } = await run(target, script, key, codexPath);
        const folder = join(directory, scenario);
        await mkdir(folder, { recursive: true });
        const name = slug(`${target.backend}-${target.model}`);
        // Node has no DOM for DOMPurify; render.ts already escapes model text.
        await writeFile(
          join(folder, `${name}.html`),
          standaloneHtml({ page, bodyHtml: renderPage(page), css }),
        );
        await writeFile(
          join(folder, `${name}.replay.html`),
          replayHtml({
            title: scenario,
            target: target.backend === "codex" ? `codex ${target.model}` : target.model,
            css,
            steps,
          }),
        );
        await writeFile(
          join(folder, `${name}.json`),
          `${JSON.stringify({ target, scenario, calls, page }, null, 2)}\n`,
        );
        const times = calls.flatMap((call) => (call.ms === undefined ? [] : [call.ms]));
        const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
        rows.push([
          scenario,
          target.backend === "codex" ? `codex ${target.model}` : target.model,
          String(calls.length),
          String(calls.filter((call) => call.error).length),
          times.length ? String(Math.round(sum(times) / times.length)) : "-",
          times.length ? String(Math.max(...times)) : "-",
          String(sum(calls.map((call) => call.applied ?? 0))),
          String(sum(calls.map((call) => call.rejected?.length ?? 0))),
          String(page.blocks.length),
        ]);
        console.error(`done ${scenario} ${target.model}`);
      }
    }),
  );
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const header = [
    "scenario",
    "model",
    "calls",
    "errors",
    "mean ms",
    "max ms",
    "applied",
    "rejected",
    "blocks",
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  console.log([line(header), ...rows.map(line)].join("\n"));
  console.log(`\nPages and call logs: ${directory}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
