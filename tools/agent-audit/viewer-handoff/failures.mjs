// Group failed tool calls by cause, read from their output. First matching rule wins.
// Each example keeps the output line that matched, so the evidence is visible.
// Usage: node failures.mjs <data.json>... <out.json>
import fs from "node:fs";
import { allCalls, lastStep, loadExports, printLeftover, tally } from "./shell.mjs";

const data = loadExports(process.argv.slice(2));

const EMPTY = (o) => o.replace(/^Error: Exit code \d+\s*/, "").trim() === "";
const exitOf = (o, it) => it.exit ?? Number((o.match(/Exit code (\d+)/) || [])[1]);
// The last step decides the exit code. Its stderr is often hidden, so the output shown
// belongs to earlier steps and must not be read as the cause.
const SEARCH = /^(rg|grep|egrep|git grep|Select-String|findstr)\b/;
const READ = /^(cat|head|tail|ls|sed|Get-Content|test|\[)\b/;
const LAST_SEARCH_EMPTY = (o, it) => SEARCH.test(lastStep(it.input)) && exitOf(o, it) === 1;
const LAST_READ_HIDDEN = (o, it) =>
  READ.test(lastStep(it.input)) && /2>\s*\/dev\/null|2>\$null/.test(lastStep(it.input));
const TO_FILE = (o, it) => /(^|[^2&])>\s*\S/.test(lastStep(it.input).replace(/2>&1/g, ""));

// [cause, output pattern, extra test on the call when the output has no clear line]
const RULES = [
  [
    "Blocked by the harness",
    /^.*((Error: )?Blocked\b|was not executed: .*blocked|Permission to use .* (was )?denied|user (rejected|declined)).*$/im,
  ],
  // 130 is Ctrl-C, 137 and 143 are kill signals: usually a server or long job stopped on purpose.
  [
    "Stopped by a signal",
    /^.*(^Terminated\b|^Killed\b|SIGTERM|SIGINT|SIGKILL).*$/m,
    (o, it) =>
      [130, 137, 143].includes(exitOf(o, it)) || ["interrupted", "running"].includes(it.status),
  ],
  ["Search found nothing", null, LAST_SEARCH_EMPTY],
  ["File not found (error hidden)", null, LAST_READ_HIDDEN],
  [
    "Shell quoting or syntax",
    /^.*(unexpected EOF while looking for matching|syntax error near unexpected token|ParserError|Missing argument in parameter list|string is missing the terminator|Unexpected token).*$/im,
  ],
  [
    "Program not found",
    /^.*(command not found|is not recognized as the name of a cmdlet|Command '.*' not found|ENOENT.*spawn|No module named).*$/im,
    (o, it) => exitOf(o, it) === 127,
  ],
  [
    "Ran in the wrong folder",
    /^.*(could not find `Cargo\.toml`|not a git repository|Could not read package\.json|no go\.mod|ERR_PNPM_NO_PKG_MANIFEST).*$/im,
  ],
  [
    "Compile or type error",
    /^.*(error\[E\d{4}\]|could not compile|error: aborting due to|error: linking with|error TS\d+|\.go:\d+:\d+: |error CS\d+|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Build failed).*$/m,
  ],
  [
    "Lint or format check failed",
    /^.*(checking code style|Format issues found|formatting issues|\d+ problems? \(|✖ \d+ problem|Found \d+ (errors?|warnings?)|would reformat|Lint failed).*$/im,
  ],
  [
    "Test failed",
    /^.*(test result: FAILED|panicked at|^test .* FAILED$|Tests? Files? .*\b[1-9]\d* failed|\b[1-9]\d* failed\b|^FAIL\b|^--- FAIL|AssertionError \[ERR_ASSERTION\]|process didn't exit successfully|=+ .*\bfailed\b.* =+).*$/m,
  ],
  ["Merge conflict", /^CONFLICT \(.*$/m],
  ["Waited on another build's lock", /^.*Blocking waiting for file lock.*$/m],
  [
    "Package manager error",
    /^.*(npm ERR!|npm error|ERR_PNPM_|error Command failed with exit code|pip.*ERROR:).*$/m,
  ],
  [
    "Service not reachable",
    /^.*(ECONNREFUSED|ECONNRESET|Cannot reach|fetch failed|is not connected|Connection refused|Could not resolve host|getaddrinfo|socket hang up).*$/im,
  ],
  // JSON error bodies often say "does not exist"; check them before path errors.
  [
    "API or HTTP error",
    /^.*(HTTP [45]\d\d|\b[45]\d\d (Bad|Not|Unauthorized|Forbidden|Internal|Service|Too)|^\s*\{.*"(error|message)"\s*:|GraphQL error|tool call error).*$/im,
  ],
  [
    "Bad arguments to a tool",
    /^.*(accepts \d+ arg\(s\)|unknown (option|flag|argument)|unrecognized (option|argument)|invalid context|usage: |Invalid parameters for tool|received an invalid|requires \S+ and \S+|missing required).*$/im,
  ],
  [
    "Timed out",
    /^.*(timed out|timeout expired|TimeoutError|operation was aborted due to timeout|deadline exceeded).*$/im,
    (o, it) => exitOf(o, it) === 124,
  ],
  [
    "Agent's own script crashed",
    /^.*(Traceback \(most recent call last\)|SyntaxError:|AssertionError|UnicodeEncodeError|ReferenceError:|TypeError:|^Node\.js v\d+|Uncaught |panic: ).*$/m,
  ],
  [
    "File or path not found",
    /^.*(No such file or directory|Cannot find path|cannot find the (path|file)|os error (2|3|123)\b|PathNotFound|does not exist|cannot access|ENOENT).*$/im,
  ],
  ["Git refused", /^(fatal|error): .*$/m],
  [
    "Search found nothing",
    null,
    (o, it) => /(^|[\s;&|'"])(rg|grep|Select-String|findstr)\b/.test(it.input || "") && EMPTY(o),
  ],
  ["Output went to a file", null, TO_FILE],
  ["No output, non-zero exit", null, (o) => EMPTY(o)],
];
const OTHER = "Other (cause not in the output)";

function classify(out, it) {
  for (const [cause, re, extra] of RULES) {
    const m = re && out.match(re);
    if (m) return [cause, m[0].trim()];
    if (extra && extra(out, it))
      return [
        cause,
        EMPTY(out)
          ? "(no output)"
          : `last step: ${lastStep(it.input).slice(0, 100)} · exit ${exitOf(out, it)}`,
      ];
  }
  return [
    OTHER,
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^Error: Exit code/.test(l))
      .pop() || "",
  ];
}

const groups = new Map();
const byProject = new Map();
const byHarness = new Map();
const byMachine = new Map();
let total = 0,
  failed = 0;
for (const { t, it, model, harness } of allCalls(data)) {
  total++;
  if (it.status === "completed") continue;
  failed++;
  const out = (it.outHead || "") + "\n" + (it.outTail || "");
  const [cause, evidence] = classify(out, it);
  const other = cause === OTHER ? 1 : 0;
  tally(byProject, `${t.source} · ${t.project}`, 1, other);
  tally(byHarness, harness || "?", 1, other);
  tally(byMachine, t.source, 1, other);
  const g = groups.get(cause) || { cause, n: 0, byModel: {}, examples: [] };
  g.n++;
  g.byModel[model || "?"] = (g.byModel[model || "?"] || 0) + 1;
  if (g.examples.length < (cause === OTHER ? 40 : 3))
    g.examples.push({
      thread: t.title,
      input: (it.input || String(it.name)).slice(-140),
      output: evidence.slice(0, 160),
    });
  groups.set(cause, g);
}
const rows = [...groups.values()].sort((a, b) => b.n - a.n);
fs.writeFileSync(data.out, JSON.stringify({ total, failed, rows }));
console.log(`${failed} of ${total} calls failed`);
for (const g of rows)
  console.log(String(g.n).padStart(4), g.cause.padEnd(32), "|", g.examples[0].output.slice(0, 90));
printLeftover("Failures left in Other, per machine", byMachine);
printLeftover("per harness", byHarness);
printLeftover("per project", byProject);
