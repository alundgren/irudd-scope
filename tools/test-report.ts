import spawn from "cross-spawn";
import { parseSync } from "vite-plus";
import { promises } from "../tests/promises.ts";
import { collectTests } from "./test-rules.ts";

type Node = { type?: string; start: number; end: number; [key: string]: unknown };
type PullRequest = { number: number; title: string; mergeCommit: { oid: string } | null };

function run(command: string, args: string[]) {
  const result = spawn.sync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function output(command: string, args: string[]) {
  const result = run(command, args);
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function callRoot(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "MemberExpression") return callRoot(node.object as Node);
  if (node.type === "CallExpression") return callRoot(node.callee as Node);
  return undefined;
}

function testName(node: Node | undefined) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral")
    return (node.quasis as { value: { raw: string } }[]).map((item) => item.value.raw).join("${}");
  return undefined;
}

// Maps each test name to its callback source without whitespace or trailing
// commas, so reformatting, timeouts, and promise tags do not count as edits.
export function testBodies(source: string) {
  const bodies = new Map<string, string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    if (node.type === "CallExpression") {
      const args = node.arguments as Node[];
      const name = testName(args[0]);
      const callback = args.findLast((arg) => /Function/.test(arg.type ?? ""));
      if (name && callback && ["test", "it"].includes(callRoot(node.callee as Node) ?? ""))
        bodies.set(
          name,
          source
            .slice(callback.start, callback.end)
            .replace(/\s+/g, "")
            .replace(/,(?=[)\]}])/g, ""),
        );
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseSync("test.ts", source).program);
  return bodies;
}

function fileAt(commit: string, file: string) {
  const result = run("git", ["show", `${commit}:${file}`]);
  return result.status === 0 ? result.stdout : "";
}

export function compareTests(before: string, after: string) {
  const old = testBodies(before);
  const current = testBodies(after);
  let added = 0;
  let edited = 0;
  for (const [name, body] of current) {
    if (!old.has(name)) added++;
    else if (old.get(name) !== body) edited++;
  }
  const deleted = [...old.keys()].filter((name) => !current.has(name)).length;
  return { added, deleted, edited };
}

async function report(since: string) {
  const pulls: PullRequest[] = JSON.parse(
    output("gh", [
      "pr",
      "list",
      "--state=merged",
      "--base=main",
      `--search=merged:>=${since}`,
      "--json=number,title,mergeCommit",
      "--limit=500",
    ]),
  );
  const lines = [`Merged pull requests since ${since}:`];
  const totals = { added: 0, deleted: 0, edited: 0 };
  for (const pull of pulls.sort((a, b) => a.number - b.number)) {
    const commit = pull.mergeCommit?.oid;
    if (!commit || run("git", ["cat-file", "-e", `${commit}^{commit}`]).status !== 0)
      throw new Error(`Merge commit for #${pull.number} is missing locally. Run git fetch origin.`);
    const files = output("git", ["diff", "--name-only", `${commit}^1`, commit, "--", "tests"])
      .split("\n")
      .filter(Boolean);
    const counts = { added: 0, deleted: 0, edited: 0 };
    for (const file of files.filter((name) => name.endsWith(".test.ts"))) {
      const change = compareTests(fileAt(`${commit}^1`, file), fileAt(commit, file));
      for (const key of ["added", "deleted", "edited"] as const) counts[key] += change[key];
    }
    for (const key of ["added", "deleted", "edited"] as const) totals[key] += counts[key];
    const rules = files.filter((name) =>
      ["tests/promises.ts", "tests/test-limits.ts"].includes(name),
    );
    lines.push(
      `  #${pull.number} ${pull.title}\n` +
        `    tests added ${counts.added}, deleted ${counts.deleted}, edited ${counts.edited}` +
        (rules.length ? `; changed ${rules.join(" and ")}` : ""),
    );
  }
  const fixes = pulls.filter((pull) => /^fix(\(.+\))?!?:/.test(pull.title));
  lines.push(
    `Totals: ${pulls.length} pull requests, ${totals.added} tests added, ${totals.deleted} deleted, ` +
      `${totals.edited} edited (${pulls.length ? (totals.edited / pulls.length).toFixed(2) : "0"} edits per pull request).`,
    `Bug fixes merged (each fixed a bug that reached main): ${fixes.length}` +
      (fixes.length ? ` (${fixes.map((pull) => `#${pull.number}`).join(", ")})` : "") +
      ".",
  );
  const { tests } = await collectTests();
  lines.push(`Tests per promise (${tests.length} tests):`);
  for (const { name } of promises)
    lines.push(`  ${name}: ${tests.filter((test) => test.tags.includes(name)).length}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const since =
    process.argv.find((arg) => arg.startsWith("--since="))?.slice("--since=".length) ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    console.log(await report(since));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
