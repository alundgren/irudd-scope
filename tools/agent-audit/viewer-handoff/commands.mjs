// Group shell calls by the program that did the work, ignoring wrapper shells.
// Usage: node commands.mjs <data.json>... <out.json>
import fs from "node:fs";
import { allCalls, loadExports, printLeftover, tally, unwrap } from "./shell.mjs";

const data = loadExports(process.argv.slice(2));

// Programs worth naming, heaviest first. When a chained command mentions several,
// the first in this list wins. `depth` is how many following words form the key.
const PROGRAMS = [
  ["cargo", 1],
  ["vp", 2],
  ["pnpm", 2],
  ["npm", 2],
  ["yarn", 2],
  ["npx", 1],
  ["bun", 2],
  ["pytest", 0],
  ["go", 1],
  ["dotnet", 1],
  ["gradle", 1],
  ["mvn", 1],
  ["make", 1],
  ["cmake", 1],
  ["docker", 1],
  ["node", 0],
  ["python", 0],
  ["python3", 0],
  ["py", 0],
  ["gh", 2],
  ["git", 1],
  ["rg", 0],
  ["grep", 0],
  ["find", 0],
  ["sed", 0],
  ["awk", 0],
  ["cat", 0],
  ["head", 0],
  ["tail", 0],
  ["ls", 0],
  ["wc", 0],
  ["sleep", 0],
  ["curl", 0],
  ["Get-Content", 0],
  ["Select-String", 0],
  ["Get-ChildItem", 0],
  ["Set-Content", 0],
];
const INTERPRETER = /^(node|python3?|py|bun|deno|vp exec node|vp exec tsx|npx tsx)$/;
const RANK = new Map(PROGRAMS.map(([p], i) => [p.toLowerCase(), i]));
const DEPTH = new Map(PROGRAMS.map(([p, d]) => [p.toLowerCase(), d]));
// A program name counts only where a command can start: line start, after a separator,
// quote or bracket, or as the last part of a path. Flags and file names don't match.
const NAME = PROGRAMS.map(([p]) => p.replace(/[-]/g, "\\-")).join("|");
const AT = new RegExp(`(?:^|[\\s;&|('"\`/\\\\])(${NAME})(?:\\.exe)?(?=[\\s'"\`;)\\\\]|$)`, "gim");

function keyOf(cmd) {
  let best = null;
  for (const m of cmd.matchAll(AT)) {
    const prog = m[1].toLowerCase();
    // `cargo +nightly test`: skip toolchain and flags when reading subcommands.
    // Flags that take a folder or package value (`go -C native build`, `pnpm --filter app test`).
    const rest = cmd
      .slice(m.index + m[0].length)
      .split(/[;&|\n]/)[0]
      .replace(/\s(-C|--manifest-path|--prefix|--dir|--cwd|--filter|-F)[= ]\S+/g, "");
    const words = rest
      .trim()
      .split(/\s+/)
      .filter((w) => w && !w.startsWith("+") && !w.startsWith("-"))
      .map((w) => w.replace(/['"`]/g, ""));
    let depth = DEPTH.get(prog);
    if (prog === "cargo" && words[0] === "xtask") depth = 2;
    // Subcommands are plain words; `go native/x.go` is a file argument, not `go native`.
    const subs = [];
    for (const w of words.slice(0, depth)) {
      if (!/^[a-z][\w:-]*$/i.test(w)) break;
      subs.push(w);
    }
    let key = [prog, ...subs].join(" ").trim();
    // Interpreters do no work themselves: name the script they run.
    if (INTERPRETER.test(key)) {
      const script = words.slice(subs.length).find((w) => /\.\w{1,4}$/.test(w));
      const stdin = !script && /(^|\s)-(\s|$)|<<|-c\s|-e\s/.test(rest);
      if (script) key += " " + script.split(/[\\/]/).pop();
      else if (stdin) key += " (inline)";
    }
    if (!best || RANK.get(prog) <= best.rank) best = { rank: RANK.get(prog), key };
  }
  return best ? best.key : byPath(cmd);
}

// `./tool.exe run`, `target/debug/deps/harness-1a2b.exe`, `/opt/bin/thing --x`: name the file.
// Setup steps (`cd`, `export`, `VAR=x`) are skipped so the program after them is found.
const SETUP =
  /^(cd|export|set|source|\.|env|echo|printf|true|mkdir|rm|cp|mv|Set-Location|\$\w+\s*=|\w+=\S*)$/i;
function byPath(cmd) {
  for (const step of unwrap(cmd).split(/;|&&|\|\||\n|\|/)) {
    const words = step
      .trim()
      .split(/\s+/)
      .filter((w) => !/^\w+=/.test(w));
    const first = (words[0] || "").replace(/^['"&(]+|['")]+$/g, "");
    if (!first || SETUP.test(first)) continue;
    if (/[\\/]/.test(first) || /\.(exe|sh|ps1|cmd|bat)$/i.test(first))
      return first
        .split(/[\\/]/)
        .pop()
        .replace(/-[0-9a-f]{8,}(?=\.exe$|$)/, "-…");
    return null;
  }
  return null;
}

// Signals read from the output, whatever wrapped the command. Outputs are clipped
// to their first and last 2 KB, so counts are lower bounds.
function signals(out) {
  return {
    compiled: (out.match(/^\s*Compiling /gm) || []).length,
    lock: /Blocking waiting for file lock/.test(out),
  };
}

const groups = new Map();
const otherSamples = [];
const byProject = new Map();
const byMachine = new Map();
let total = 0,
  calls = 0;
const SHELL = /^(shell|Bash|PowerShell|exec_command|shell_command|local_shell)$/;
{
  for (const { t, it, model: m } of allCalls(data)) {
    const model = m || "?";
    {
      {
        if (it.kind !== "command_execution" && !SHELL.test(it.name)) continue;
        const ms = it.durMs || 0;
        total += ms;
        calls++;
        const key = keyOf(it.input || "") || "(other)";
        tally(byProject, `${t.source} · ${t.project}`, ms / 6e4, key === "(other)" ? ms / 6e4 : 0);
        tally(byMachine, t.source, ms / 6e4, key === "(other)" ? ms / 6e4 : 0);
        if (key === "(other)" && otherSamples.length < 400)
          otherSamples.push([ms, (it.input || "").slice(0, 160)]);
        const s = signals((it.outHead || "") + "\n" + (it.outTail || ""));
        const g = groups.get(key) || {
          key,
          n: 0,
          ms: 0,
          max: 0,
          failed: 0,
          cold: 0,
          lock: 0,
          byModel: {},
        };
        g.n++;
        g.ms += ms;
        g.max = Math.max(g.max, ms);
        g.failed += it.status !== "completed";
        g.cold += s.compiled >= 10;
        g.lock += s.lock;
        const bm = (g.byModel[model] ||= { n: 0, ms: 0 });
        bm.n++;
        bm.ms += ms;
        (g.slowest ||= []).push([ms, (it.input || "").slice(-220)]);
        g.slowest.sort((a, b) => b[0] - a[0]);
        g.slowest.length = Math.min(g.slowest.length, 3);
        groups.set(key, g);
      }
    }
  }
}
const rows = [...groups.values()].sort((a, b) => b.ms - a.ms);
otherSamples.sort((a, b) => b[0] - a[0]);
fs.writeFileSync(
  data.out,
  JSON.stringify({
    total,
    calls,
    groups: rows.length,
    rows: rows.slice(0, 25),
    other: groups.get("(other)") || null,
    otherSamples: otherSamples.slice(0, 8),
  }),
);
const o = groups.get("(other)");
console.log(
  `${calls} shell calls, ${(total / 3.6e6).toFixed(1)} h, ${rows.length} groups; other = ${o ? o.n : 0} calls, ${o ? ((o.ms / total) * 100).toFixed(1) : 0}% of time`,
);
for (const r of rows.slice(0, 15))
  console.log(
    r.key.padEnd(28),
    String(r.n).padStart(5),
    (r.ms / 6e4).toFixed(0).padStart(6) + "m",
    "cold",
    r.cold,
    "lock",
    r.lock,
  );
for (const k of (process.env.SHOW || "").split(",").filter(Boolean)) {
  console.log("slowest", k);
  for (const [ms, c] of groups.get(k)?.slowest || [])
    console.log("  " + (ms / 6e4).toFixed(1) + "m", JSON.stringify(c));
}
console.log("top other:");
for (const [ms, c] of otherSamples.slice(0, 8))
  console.log((ms / 6e4).toFixed(1) + "m", JSON.stringify(c));
printLeftover("Minutes of shell time in (other), per machine", byMachine);
printLeftover("per project", byProject);
