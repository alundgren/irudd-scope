// Group failed tool calls by cause, read from their output. First matching rule wins.
// Each example keeps the output line that matched, so the evidence is visible.
// Usage: node failures.mjs <data.json> <out.json>
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const EMPTY = (o) => o.replace(/^Error: Exit code \d+\s*/, "").trim() === "";
// [cause, output pattern, extra test on the call when the output has no clear line]
const RULES = [
  ["Blocked by the harness", /^(Error: )?Blocked\b.*$/m],
  [
    "Shell quoting or syntax",
    /^.*(unexpected EOF while looking for matching|syntax error near unexpected token|ParserError|Missing argument in parameter list|string is missing the terminator|Unexpected token).*$/im,
  ],
  [
    "Program not found",
    /^.*(command not found|is not recognized as the name of a cmdlet).*$/im,
    (o, it) => it.exit === 127 || /Exit code 127\b/.test(o),
  ],
  [
    "Ran in the wrong folder",
    /^.*(could not find `Cargo\.toml`|not a git repository|Could not read package\.json).*$/im,
  ],
  [
    "Compile error",
    /^.*(error\[E\d{4}\]|could not compile|error: aborting due to|error: linking with).*$/m,
  ],
  [
    "Test failed",
    /^.*(test result: FAILED|panicked at|^test .* FAILED$|\b[1-9]\d* failed\b|process didn't exit successfully).*$/m,
  ],
  [
    "Agent's own script crashed",
    /^.*(Traceback \(most recent call last\)|SyntaxError:|AssertionError|UnicodeEncodeError|ReferenceError:|TypeError:).*$/m,
  ],
  ["Merge conflict", /^CONFLICT \(.*$/m],
  ["Waited on another build's lock", /^.*Blocking waiting for file lock.*$/m],
  [
    "Bad arguments to a tool",
    /^.*(accepts \d+ arg\(s\)|unknown (option|flag)|invalid context|usage: |Invalid parameters for tool).*$/im,
  ],
  [
    "File or path not found",
    /^.*(No such file or directory|Cannot find path|cannot find the (path|file)|os error (2|3|123)\b|PathNotFound|does not exist|cannot access).*$/im,
  ],
  ["Git refused", /^fatal: .*$/m],
  ["GitHub or network", /^.*(HTTP [45]\d\d|Could not resolve host|GraphQL error).*$/im],
  ["Timed out", /^.*(timed out|timeout expired).*$/im, (o, it) => it.exit === 124],
  [
    "Search found nothing",
    null,
    (o, it) => /(^|[\s;&|'"])(rg|grep|Select-String|findstr)\b/.test(it.input || "") && EMPTY(o),
  ],
  ["No output, non-zero exit", null, (o) => EMPTY(o)],
];
const short = (m) =>
  ({
    "claude-opus-5-5": "Opus 5.5",
    "gpt-6.1-sol": "GPT-6.1 Sol",
    "gpt-6-astra": "GPT-6 Astra",
    "grok-4.7-build-fast": "Grok 4.7",
  })[m] ||
  m ||
  "?";

function classify(out, it) {
  for (const [cause, re, extra] of RULES) {
    const m = re && out.match(re);
    if (m) return [cause, m[0].trim()];
    if (extra && extra(out, it))
      return [
        cause,
        EMPTY(out)
          ? "(no output)"
          : `exit code ${it.exit ?? (out.match(/Exit code (\d+)/) || [])[1]}`,
      ];
  }
  return [
    "Other (cause not in the output)",
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^Error: Exit code/.test(l))
      .pop() || "",
  ];
}

const groups = new Map();
let total = 0,
  failed = 0;
for (const t of data.threads)
  for (const r of t.runs)
    for (const tu of r.turns)
      for (const it of tu.items) {
        total++;
        if (it.status === "completed") continue;
        failed++;
        const out = (it.outHead || "") + "\n" + (it.outTail || "");
        const [cause, evidence] = classify(out, it);
        const g = groups.get(cause) || { cause, n: 0, byModel: {}, examples: [] };
        g.n++;
        const m = short(r.model);
        g.byModel[m] = (g.byModel[m] || 0) + 1;
        if (g.examples.length < 3)
          g.examples.push({
            thread: t.title,
            input: (it.input || String(it.name)).slice(-140),
            output: evidence.slice(0, 160),
          });
        groups.set(cause, g);
      }
const rows = [...groups.values()].sort((a, b) => b.n - a.n);
fs.writeFileSync(process.argv[3], JSON.stringify({ total, failed, rows }));
console.log(`${failed} of ${total} calls failed`);
for (const g of rows)
  console.log(
    String(g.n).padStart(4),
    g.cause.padEnd(32),
    JSON.stringify(g.byModel),
    "|",
    g.examples[0].output.slice(0, 70),
  );
