/**
 * Sorts tool calls by the program that did the work and failed calls by cause, using rules read
 * from the call's text. Both keep an "other" bucket for what the rules do not recognize, so a
 * gap in the rules stays visible. No Node or browser imports: the tab runs this.
 */
import type { SessionCall } from "./contract.ts";

// `bash -lc '…'` and `powershell -Command "…"` wrap the real command; read inside them.
const WRAPPER =
  /^\s*\S*?(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*(['"])([\s\S]*)\1\s*$/i;

function unwrap(command: string) {
  let text = command;
  for (let match = WRAPPER.exec(text); match; match = WRAPPER.exec(text)) text = match[2]!;
  return text;
}

/** The step whose exit code the shell reports: the last in a `;`, `&&`, `||` or newline chain. */
function lastStep(command: string) {
  const steps = unwrap(command)
    .split(/;|&&|\|\||\n/)
    .map((step) => step.trim())
    .filter((step) => step && !/^(fi|done|esac|\}|\)|EOF|JS|PY)$/.test(step));
  return steps.at(-1) ?? "";
}

export const isShell = (call: Pick<SessionCall, "kind" | "name">) =>
  call.kind === "command_execution" ||
  /^(shell|Bash|PowerShell|exec_command|shell_command|local_shell)$/.test(call.name);

// Programs worth naming, heaviest first. When a chained command names several, the first in
// this list wins. The number is how many following words belong to the name.
const PROGRAMS: Array<[string, number]> = [
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
const RANK = new Map(PROGRAMS.map(([name], index) => [name.toLowerCase(), index]));
const DEPTH = new Map(PROGRAMS.map(([name, depth]) => [name.toLowerCase(), depth]));
// A program name counts only where a command can start: line start, after a separator, quote
// or bracket, or as the last part of a path. Flags and file names do not match.
const AT = new RegExp(
  `(?:^|[\\s;&|('"\`/\\\\])(${PROGRAMS.map(([name]) => name.replace(/-/g, "\\-")).join("|")})(?:\\.exe)?(?=[\\s'"\`;)\\\\]|$)`,
  "gim",
);
// Setup steps are skipped so the program after them is found.
const SETUP =
  /^(cd|export|set|source|\.|env|echo|printf|true|mkdir|rm|cp|mv|Set-Location|\$\w+\s*=|\w+=\S*)$/i;

/** `./tool.exe run`, `target/debug/deps/harness-1a2b.exe`: the program is named after its file. */
function programByPath(command: string) {
  for (const step of unwrap(command).split(/;|&&|\|\||\n|\|/)) {
    const words = step
      .trim()
      .split(/\s+/)
      .filter((word) => !/^\w+=/.test(word));
    const first = (words[0] ?? "").replace(/^['"&(]+|['")]+$/g, "");
    if (!first || SETUP.test(first)) continue;
    if (/[\\/]/.test(first) || /\.(exe|sh|ps1|cmd|bat)$/i.test(first))
      return first
        .split(/[\\/]/)
        .pop()!
        .replace(/-[0-9a-f]{8,}(?=\.exe$|$)/, "-…");
    return null;
  }
  return null;
}

/** The program a shell command ran, such as `cargo test` or `vp run check`, or null. */
export function programOf(command: string): string | null {
  let best: { rank: number; key: string } | null = null;
  for (const match of command.matchAll(AT)) {
    const program = match[1]!.toLowerCase();
    // Flags that take a folder or package value: `go -C native build`, `pnpm --filter app test`.
    const rest = command
      .slice(match.index + match[0].length)
      .split(/[;&|\n]/)[0]!
      .replace(/\s(-C|--manifest-path|--prefix|--dir|--cwd|--filter|-F)[= ]\S+/g, "");
    // `cargo +nightly test`: toolchains and flags are not subcommands.
    const words = rest
      .trim()
      .split(/\s+/)
      .filter((word) => word && !word.startsWith("+") && !word.startsWith("-"))
      .map((word) => word.replace(/['"`]/g, ""));
    const depth = program === "cargo" && words[0] === "xtask" ? 2 : DEPTH.get(program)!;
    // Subcommands are plain words; `go native/x.go` names a file, not `go native`.
    const subcommands: string[] = [];
    for (const word of words.slice(0, depth)) {
      if (!/^[a-z][\w:-]*$/i.test(word)) break;
      subcommands.push(word);
    }
    let key = [program, ...subcommands].join(" ");
    // Interpreters do no work themselves: name the script they run.
    if (INTERPRETER.test(key)) {
      const script = words.slice(subcommands.length).find((word) => /\.\w{1,4}$/.test(word));
      if (script) key += ` ${script.split(/[\\/]/).pop()}`;
      else if (/(^|\s)-(\s|$)|<<|-c\s|-e\s/.test(rest)) key += " (inline)";
    }
    const rank = RANK.get(program)!;
    if (!best || rank <= best.rank) best = { rank, key };
  }
  return best?.key ?? programByPath(command);
}

const output = (call: Pick<SessionCall, "outputHead" | "outputTail">) =>
  `${call.outputHead}\n${call.outputTail}`;

/** Read from output clipped to 2 KB at each end, so both are lower bounds. */
export function buildSignals(call: Pick<SessionCall, "outputHead" | "outputTail">) {
  const text = output(call);
  return {
    coldBuild: (text.match(/^\s*Compiling /gm) ?? []).length >= 10,
    lockWait: /Blocking waiting for file lock/.test(text),
  };
}

type Call = Pick<SessionCall, "input" | "exit" | "status" | "outputHead" | "outputTail">;
const empty = (text: string) => text.replace(/^Error: Exit code \d+\s*/, "").trim() === "";
const exitOf = (text: string, call: Call) =>
  call.exit ?? Number(/Exit code (\d+)/.exec(text)?.[1] ?? Number.NaN);
const SEARCH = /^(rg|grep|egrep|git grep|Select-String|findstr)\b/;
const READ = /^(cat|head|tail|ls|sed|Get-Content|test|\[)\b/;

type Rule = [cause: string, pattern: RegExp | null, test?: (text: string, call: Call) => boolean];
// The first matching rule wins. The last step decides a chained command's exit code, and its
// error is often hidden, so rules about the last step run before output matching.
const RULES: Rule[] = [
  [
    "Blocked by the harness",
    /^.*((Error: )?Blocked\b|was not executed: .*blocked|Permission to use .* (was )?denied|user (rejected|declined)).*$/im,
  ],
  // 130 is Ctrl-C, 137 and 143 are kill signals: usually a server or long job stopped on purpose.
  [
    "Stopped by a signal",
    /^.*(^Terminated\b|^Killed\b|SIGTERM|SIGINT|SIGKILL).*$/m,
    (text, call) =>
      [130, 137, 143].includes(exitOf(text, call)) ||
      ["interrupted", "running"].includes(call.status),
  ],
  [
    "Search found nothing",
    null,
    (text, call) => SEARCH.test(lastStep(call.input)) && exitOf(text, call) === 1,
  ],
  [
    "File not found (error hidden)",
    null,
    (_text, call) =>
      READ.test(lastStep(call.input)) && /2>\s*\/dev\/null|2>\$null/.test(lastStep(call.input)),
  ],
  [
    "Shell quoting or syntax",
    /^.*(unexpected EOF while looking for matching|syntax error near unexpected token|ParserError|Missing argument in parameter list|string is missing the terminator|Unexpected token).*$/im,
  ],
  [
    "Program not found",
    /^.*(command not found|is not recognized as the name of a cmdlet|Command '.*' not found|ENOENT.*spawn|No module named).*$/im,
    (text, call) => exitOf(text, call) === 127,
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
    (text, call) => exitOf(text, call) === 124,
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
    (text, call) =>
      /(^|[\s;&|'"])(rg|grep|Select-String|findstr)\b/.test(call.input) && empty(text),
  ],
  [
    "Output went to a file",
    null,
    (_text, call) => /(^|[^2&])>\s*\S/.test(lastStep(call.input).replace(/2>&1/g, "")),
  ],
  ["No output, non-zero exit", null, (text) => empty(text)],
];
export const OTHER_CAUSE = "Other (cause not in the output)";

/** Why a failed call failed, and the output line or step that decided it. */
export function causeOf(call: Call): { cause: string; evidence: string } {
  const text = output(call);
  for (const [cause, pattern, test] of RULES) {
    const match = pattern?.exec(text);
    if (match) return { cause, evidence: match[0].trim() };
    if (test?.(text, call)) {
      const exit = exitOf(text, call);
      return {
        cause,
        evidence: empty(text)
          ? "(no output)"
          : `last step: ${lastStep(call.input).slice(0, 120)}${Number.isNaN(exit) ? "" : ` · exit ${exit}`}`,
      };
    }
  }
  const last = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Error: Exit code"))
    .at(-1);
  return { cause: OTHER_CAUSE, evidence: last ?? "" };
}

export const failed = (call: Pick<SessionCall, "status">) => call.status !== "completed";

export type ProgramGroup = {
  program: string | null;
  calls: SessionCall[];
  durationMs: number;
  slowestMs: number;
  failed: number;
  coldBuilds: number;
  lockWaits: number;
};

/** Shell calls by program, slowest total first. `program: null` holds the unmatched calls. */
export function byProgram(calls: SessionCall[]): ProgramGroup[] {
  const groups = new Map<string | null, ProgramGroup>();
  for (const call of calls) {
    if (!isShell(call)) continue;
    const program = programOf(call.input);
    const group = groups.get(program) ?? {
      program,
      calls: [],
      durationMs: 0,
      slowestMs: 0,
      failed: 0,
      coldBuilds: 0,
      lockWaits: 0,
    };
    const ms = call.durationMs ?? 0;
    const signals = buildSignals(call);
    group.calls.push(call);
    group.durationMs += ms;
    group.slowestMs = Math.max(group.slowestMs, ms);
    group.failed += failed(call) ? 1 : 0;
    group.coldBuilds += signals.coldBuild ? 1 : 0;
    group.lockWaits += signals.lockWait ? 1 : 0;
    groups.set(program, group);
  }
  return [...groups.values()].sort((a, b) => b.durationMs - a.durationMs);
}

export type CauseGroup = {
  cause: string;
  calls: Array<{ call: SessionCall; evidence: string }>;
};

/** Failed calls by cause, most first. */
export function byCause(calls: SessionCall[]): CauseGroup[] {
  const groups = new Map<string, CauseGroup>();
  for (const call of calls) {
    if (!failed(call)) continue;
    const { cause, evidence } = causeOf(call);
    const group = groups.get(cause) ?? { cause, calls: [] };
    group.calls.push({ call, evidence });
    groups.set(cause, group);
  }
  return [...groups.values()].sort((a, b) => b.calls.length - a.calls.length);
}
