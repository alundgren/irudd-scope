// Shared helpers for reading shell commands and loading several exports at once.
import fs from "node:fs";

// `bash -lc '…'` and `powershell -Command "…"` wrap the real command; read inside them.
const WRAPPER =
  /^\s*\S*?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*(['"])([\s\S]*)\1\s*$/i;

export function unwrap(cmd) {
  let s = cmd || "";
  for (let m; (m = s.match(WRAPPER));) s = m[2];
  return s;
}

// The step whose exit code the shell reports: the last one in a `;`, `&&`, `||` or newline chain.
export function lastStep(cmd) {
  const steps = unwrap(cmd)
    .split(/;|&&|\|\||\n/)
    .map((x) => x.trim())
    .filter((x) => x && !/^(fi|done|esac|\}|\)|EOF|JS|PY)$/.test(x));
  return steps.at(-1) || "";
}

// Every argument after the script paths is an export; the last argument is the output file.
// Each thread gets `source` set to its export's machine so results can be split per machine.
export function loadExports(args) {
  const out = args.at(-1);
  const threads = [];
  const logs = [];
  for (const file of args.slice(0, -1)) {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const t of d.threads) threads.push({ ...t, source: d.machine || file });
    for (const l of d.logs || []) logs.push({ ...l, source: d.machine || file });
  }
  return { threads, logs, out };
}

const HARNESS = { claudeAgent: "claude", codex: "codex" };

// Every tool call once: T3 items sit on a turn, a run or the thread itself; harness logs
// carry tool calls only for threads T3 recorded none for.
export function* allCalls({ threads, logs }) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const t of threads) {
    const first = t.runs[0] || {};
    for (const it of t.items)
      yield { t, it, model: first.model, harness: HARNESS[first.provider] || first.provider };
    for (const r of t.runs) {
      const base = { t, model: r.model, harness: HARNESS[r.provider] || r.provider };
      for (const it of r.items) yield { ...base, it };
      for (const tu of r.turns) for (const it of tu.items) yield { ...base, it };
    }
  }
  for (const l of logs) {
    const t = byId.get(l.threadId) || {
      title: l.path,
      project: "(no T3 thread)",
      source: l.source,
    };
    for (const it of l.toolCalls || [])
      yield { t, it, model: Object.keys(l.models || {})[0], harness: l.harness };
  }
}

// Print each group's share of a leftover bucket, so a rule set tuned on one project shows its gaps.
export function printLeftover(title, rows) {
  console.log(`\n${title}`);
  console.log("".padEnd(36), "total".padStart(7), "other".padStart(7), "share".padStart(7));
  for (const [k, v] of [...rows].sort((a, b) => b[1].total - a[1].total))
    console.log(
      k.slice(0, 36).padEnd(36),
      String(Math.round(v.total)).padStart(7),
      String(Math.round(v.other)).padStart(7),
      (v.total ? ((v.other / v.total) * 100).toFixed(0) + "%" : "-").padStart(7),
    );
}

export function tally(map, key, total, other) {
  const v = map.get(key) || { total: 0, other: 0 };
  v.total += total;
  v.other += other;
  map.set(key, v);
}
