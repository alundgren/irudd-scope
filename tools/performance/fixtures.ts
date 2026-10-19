import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { memoryFixture } from "../../tests/memory-fixture.ts";
import { pressureContent } from "../../tests/pressure-fixture.ts";
import type { Options } from "../performance.ts";

export async function fixtures(options: Options) {
  const cleanup: (() => Promise<unknown> | void)[] = [];
  const memory = await memoryFixture(cleanup);
  const directory = join(
    options.runDir,
    "data",
    `attempt-${process.env.SCOPE_PERFORMANCE_ATTEMPT ?? "0"}`,
  );
  await mkdir(directory, { recursive: true });
  let native = false;
  let nativeReason = "No native binary supplied";
  if (options.okfBinary) {
    const probeRoot = join(directory, "native-probe");
    await mkdir(probeRoot);
    await writeFile(
      join(probeRoot, "memory-bundle.json"),
      JSON.stringify({ id: randomUUID(), formatVersion: 2, name: "personal" }),
    );
    const invokedAt = Date.now(),
      start = performance.now();
    try {
      const result = await promisify(execFile)(
        options.okfBinary,
        ["--bundle", `personal=${probeRoot}`, "bundle", "inspect", "personal"],
        {
          env: { ...process.env, XDG_CONFIG_HOME: join(options.runDir, "config") },
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      const inspected = JSON.parse(result.stdout);
      native = inspected.status === "current" && inspected.formatVersion === 2;
      nativeReason = native
        ? "Compatible native binary"
        : "Native binary cannot inspect a format-v2 bundle";
    } catch (error) {
      nativeReason = `Native binary lacks current bundle inspect support: ${String(error).slice(0, 500)}`;
    }
    appendFileSync(
      join(options.runDir, "external.jsonl"),
      JSON.stringify({
        type: "external-end",
        tool: "irudd-okf",
        operation: "capability-probe",
        feature: "librarian.native-engine",
        native: true,
        invokedAt,
        completedAt: Date.now(),
        durationMs: performance.now() - start,
        reason: nativeReason,
      }) + "\n",
    );
  }
  const bin = join(directory, "bin");
  await mkdir(bin);
  const env = memory.env("performance");
  const git = env.FAKE_REAL_GIT!;
  const prScript = join(directory, "github.mjs");
  await writeFile(prScript, githubScript());
  const targets = {
    git,
    gh: resolve("tests/fixtures/memory/bin/gh"),
    "irudd-okf": native ? options.okfBinary! : resolve("tests/fixtures/memory/bin/irudd-okf"),
  };
  for (const [name, target] of Object.entries(targets)) {
    await writeFile(
      join(bin, name),
      `#!${process.execPath}
import { readFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const invokedAt = Date.now(), invokedMonoMs = performance.now();
const context = JSON.parse(readFileSync(${JSON.stringify(join(options.runDir, "data", "context.json"))}, 'utf8'));
const args = process.argv.slice(2);
const tool = ${JSON.stringify(name)};
const externalId = process.pid + '-' + invokedAt;
const log = data => appendFileSync(${JSON.stringify(join(options.runDir, "external.jsonl"))}, JSON.stringify({ tool, externalId, pid:process.pid, native: ${name === "irudd-okf" && native} && context.feature !== "memory.sync", ...context, ...data }) + '\\n');
log({type:'external-start', invokedAt, invokedMonoMs, command: args[0] ?? ''});
if (context.delayMs && tool === 'gh') await delay(context.delayMs);
const pr = tool === 'gh' && (['api','pr'].includes(args[0]) || args.includes('user'));
const command = pr ? process.execPath : tool === 'irudd-okf' && context.feature === 'memory.sync' ? ${JSON.stringify(resolve("tests/fixtures/memory/bin/irudd-okf"))} : ${JSON.stringify(target)};
const commandArgs = pr ? [${JSON.stringify(prScript)}, ...args] : args;
const startedAt = Date.now();
const usagePath = ${JSON.stringify(join(options.runDir, "data"))} + '/usage-' + externalId + '.json';
const timed = existsSync('/usr/bin/time');
const child = spawn(timed ? '/usr/bin/time' : command, timed ? ['-f','{"userSeconds":%U,"systemSeconds":%S,"maxRssKiB":%M}', '-o', usagePath, command, ...commandArgs] : commandArgs, {stdio:'inherit'});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', error => { log({type:'external-end', invokedAt, startedAt, completedAt:Date.now(), durationMs:performance.now()-invokedMonoMs, error:String(error)}); process.exitCode=1; });
child.on('exit', (code, signal) => { let usage = null; try { usage = JSON.parse(readFileSync(usagePath, 'utf8').trim().split('\\n').at(-1)); unlinkSync(usagePath); } catch {} log({usage, wrapperCpuMicroseconds:process.cpuUsage(), type:'external-end', invokedAt, startedAt, completedAt:Date.now(), durationMs:performance.now()-invokedMonoMs, injectedDelayMs: context.delayMs && tool==='gh' ? context.delayMs : 0, code, signal}); process.exitCode=code ?? 1; });
`,
      { mode: 0o700 },
    );
  }
  const root = join(directory, "local-memory");
  await mkdir(root);
  await writeFile(
    join(root, "memory-bundle.json"),
    JSON.stringify({ id: randomUUID(), formatVersion: 2, name: "performance" }),
  );
  await writeFile(join(root, "index.md"), "# Synthetic memory\n");
  const count = options.smoke ? 12 : 1000;
  const reserve = join(directory, "memory-reserve");
  await mkdir(reserve);
  const memoryCount = options.smoke ? 4 : 10;
  for (let i = 0; i < count; i++)
    await writeFile(
      join(i < memoryCount ? root : reserve, `note-${String(i).padStart(4, "0")}.md`),
      memoryRaw(i),
    );
  const files: Record<string, string> = {};
  for (const [index, kind] of [
    "text",
    "markdown",
    "html",
    "image",
    "file",
    "excalidraw",
  ].entries()) {
    const content = pressureContent(
      kind === "markdown" ? 7 : index,
      0,
      0,
      options.smoke ? 16 : 256,
    );
    files[kind] = join(directory, content.fileName.replace("note.", `${kind}.`));
    await writeFile(files[kind], content.bytes);
  }
  files.large = join(directory, "large.md");
  await writeFile(
    files.large,
    "# Large performance note\n\n" + "Synthetic paragraph for rendering.\n\n".repeat(28_000),
  );
  files.plan = join(directory, "plan.html");
  await writeFile(
    files.plan,
    "<!doctype html><h1>Performance plan</h1><p>Review synthetic work.</p>",
  );
  for (const kind of ["pull-requests", "retro"]) {
    files[kind] = join(directory, `${kind}.html`);
    const html = await readFile(`apps/desktop/src/plugins/${kind}/starter.html`, "utf8");
    await writeFile(
      files[kind],
      html.replaceAll(
        "/* SCOPE_TOKENS */",
        await readFile("apps/desktop/src/renderer/tokens.css", "utf8"),
      ),
    );
  }
  const promptIds = Array.from({ length: options.smoke ? 12 : 1000 }, () => randomUUID());
  return {
    memory,
    root,
    files,
    promptIds,
    promptCount: 0,
    memoryCount,
    reserve,
    native,
    nativeReason,
    env: {
      ...env,
      PATH: [bin, env.PATH].join(delimiter),
      XDG_CONFIG_HOME: join(options.runDir, "config"),
      XDG_CACHE_HOME: join(options.runDir, "cache"),
      XDG_DATA_HOME: directory,
      SCOPE_MEMORY_DIR: memory.root("desktop"),
    },
    cleanup,
  };
}
export function memoryRaw(i: number, suffix = "") {
  return `---\ntype: Memory\ntitle: Performance memory ${i}\nmemory: ${JSON.stringify({ id: `performance-${i}`, kind: "procedural", stage: "bronze", applicability: { type: "global" } })}\n---\nSynthetic performance memory ${i}. ${suffix}\n`;
}
function githubScript() {
  return `
const args = process.argv.slice(2);
const complete = {hasNextPage:false,endCursor:null};
const head='a'.repeat(40),base='b'.repeat(40);
const repository={id:'R_SYNTHETIC',owner:{login:'synthetic'},name:'project',nameWithOwner:'synthetic/project'};
const row={state:'OPEN',id:'PR_PERFORMANCE_1',number:1,title:'Performance review',author:{login:'colleague'},repository,labels:{nodes:[],pageInfo:complete},headRefOid:head,headRefName:'feature',stack:null,stackEntry:null,reviewDecision:null,latestOpinionatedReviews:{totalCount:0,nodes:[],pageInfo:complete},baseRefOid:base,reviewRequests:{nodes:[],pageInfo:complete},reviewThreads:{nodes:[],pageInfo:complete},isDraft:false,additions:1,deletions:1,changedFiles:1,url:'https://github.com/synthetic/project/pull/1',mergeable:'MERGEABLE',createdAt:'2026-10-01T12:00:00Z',updatedAt:'2026-10-01T12:00:00Z',commits:{nodes:[{commit:{oid:head,statusCheckRollup:{state:'SUCCESS',commit:{oid:head}}}}]}};
const common={viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2099-10-02T00:00:00Z'}};
const query=args.join(' ');
let reply;
if(query.includes('ScopeInitialOpenPullRequests') || query.includes('ScopeOpenPullRequests')) reply={data:{...common,repository:{...repository,pullRequests:{nodes:[row],pageInfo:complete}}}};
else if(query.includes('ScopeEnrichPullRequests')) reply={data:{...common,nodes:[row]}};
else if(query.includes('ScopeCurrentPullRequest')) reply={data:{...common,repository:{...repository,pullRequest:row}}};
else if(query.includes('ScopePullRequestReviewBody')) reply={data:{...common,repository:{...repository,pullRequest:{id:row.id,state:'OPEN',headRefOid:head,baseRefOid:base,body:'Synthetic performance details'}}}};
else if(args[0]==='pr' && args[1]==='diff') { console.log('diff --git a/example.ts b/example.ts\\n--- a/example.ts\\n+++ b/example.ts\\n@@ -1 +1 @@\\n-old value\\n+new value'); process.exit(0); }
else if(query.includes('/files?')) reply=[{sha:'c'.repeat(40),filename:'example.ts',additions:1,deletions:1,changes:2,status:'modified',blob_url:'https://github.com/synthetic/project/blob/example.ts'}];
else if(query.includes('/reviews?')) reply=[];
else if(args.includes('user')) reply={login:'viewer'};
else throw new Error('Unsupported synthetic GitHub read');
console.log(JSON.stringify(reply));
`;
}
