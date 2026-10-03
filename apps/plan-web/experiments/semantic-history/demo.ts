import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PlanStore } from "../../src/backend/store.ts";
import { SemanticHistory, type Proposal } from "./store.ts";
import type { Actor } from "../../src/contracts.ts";

const actors: Actor[] = ["Architecture", "Managed storage", "Deployment"].map((name, index) => ({
  id: `agent-${index}`,
  name: `${name} agent`,
  kind: "agent",
}));
const base =
  '<!doctype html><html><head><title>Storage review</title></head><body><h1 id="heading">Storage</h1><p id="database">Use PostgreSQL.</p><p id="budget">Budget 0</p></body></html>';
const requests: Proposal[] = [
  {
    id: "sqlite",
    branch: "main",
    parentRevision: 0,
    actor: actors[0],
    reason: "Simplify standalone deployment.",
    operation: {
      kind: "replace-text",
      nodeId: "database",
      expectedText: "Use PostgreSQL.",
      text: "Use SQLite.",
    },
  },
  {
    id: "dynamo",
    branch: "main",
    parentRevision: 0,
    actor: actors[1],
    reason: "Avoid managing database infrastructure.",
    operation: {
      kind: "replace-text",
      nodeId: "database",
      expectedText: "Use PostgreSQL.",
      text: "Use DynamoDB.",
    },
  },
  {
    id: "context",
    branch: "main",
    parentRevision: 0,
    actor: actors[2],
    reason: "Retain deployment context independently of the decision.",
    operation: {
      kind: "insert-after",
      nodeId: "database",
      html: '<section id="deployment"><h2>Deployment</h2><p>Document PostgreSQL deployment constraints.</p></section>',
    },
  },
];
function legacyHtml(proposal: Proposal) {
  const op = proposal.operation;
  return op.kind === "replace-text"
    ? base.replace(op.expectedText, op.text)
    : op.kind === "insert-after"
      ? base.replace('</p><p id="budget">', `</p>${op.html}<p id="budget">`)
      : base;
}
function retainedLegacyBytes(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare(`SELECT
      (SELECT COALESCE(SUM(length(CAST(event AS BLOB))),0) FROM versions)
      + (SELECT COALESCE(SUM(length(CAST(command AS BLOB))+length(CAST(outcome AS BLOB))),0) FROM receipts)
      + (SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))),0) FROM plans) AS bytes`)
        .get() as { bytes: number }
    ).bytes;
  } finally {
    db.close();
  }
}
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const measure = <T>(work: () => T) => {
  const started = performance.now();
  const result = work();
  return { result, ms: performance.now() - started };
};
function comparison(directory: string) {
  const current = new PlanStore(join(directory, "current-conflict.db"));
  const candidate = new SemanticHistory(join(directory, "semantic-conflict.db"), 2);
  try {
    const original = current.snapshot("comparison");
    current.command("comparison", {
      kind: "html",
      requestId: randomUUID(),
      actor: actors[0],
      baseHtmlRevision: original.htmlRevision,
      html: base,
    });
    const start = current.snapshot("comparison");
    candidate.create("comparison", base);
    const existing = requests.map((proposal) =>
      current.command("comparison", {
        kind: "html",
        requestId: proposal.id,
        actor: proposal.actor,
        baseHtmlRevision: start.htmlRevision,
        html: legacyHtml(proposal),
      }),
    );
    const proposed = requests.map((proposal) => candidate.propose("comparison", proposal));
    const legacy = current.snapshot("comparison");
    const semantic = candidate.read("comparison");
    if (!legacy.html.includes('id="deployment"') || !semantic.html.includes('id="deployment"'))
      throw new Error("Independent change was lost.");
    return {
      current: {
        outcomes: existing.map((outcome) => outcome.status),
        html: legacy.html,
        historyEntries: current.versions("comparison", legacy.revision + 1, 100).versions.length,
        retainedLogicalBytes: retainedLegacyBytes(join(directory, "current-conflict.db")),
      },
      semantic: {
        outcomes: proposed.map((receipt) => receipt.outcome),
        html: semantic.html,
        conflicts: Object.values(semantic.conflicts),
        changes: candidate.history("comparison"),
        footprint: candidate.footprint(),
      },
    };
  } finally {
    current.close();
    candidate.close();
  }
}
function branchComparison(directory: string) {
  const store = new SemanticHistory(join(directory, "branches.db"), 2);
  try {
    store.create("branches", base);
    store.branch("branches", "sqlite", 0);
    store.branch("branches", "dynamo", 0);
    const before = store.footprint();
    const sqlite = store.propose("branches", { ...requests[0], branch: "sqlite" });
    const dynamo = store.propose("branches", { ...requests[1], branch: "dynamo" });
    store.propose("branches", requests[2]);
    const identity = {
      id: "merge-sqlite",
      actor: actors[0],
      reason: "Review the first alternative.",
    };
    store.merge("branches", "main", "sqlite", identity);
    const merged = store.merge("branches", "main", "dynamo", {
      ...identity,
      id: "merge-dynamo",
      reason: "Expose competing storage choices.",
    });
    const pending = store.read("branches");
    const resolved = store.propose("branches", {
      ...requests[0],
      id: "resolve",
      parentRevision: merged.revision,
      reason: "Choose the standalone option while retaining deployment analysis.",
      operation: {
        kind: "resolve",
        conflictId: merged.conflictIds[0],
        text: "Use SQLite for v1. Revisit managed storage if requirements change.",
      },
    });
    return {
      forksBeforeEdits: before,
      sqlite: store.read("branches", sqlite.revision),
      dynamo: store.read("branches", dynamo.revision),
      pending,
      resolved: store.read("branches", resolved.revision),
      history: store.history("branches"),
    };
  } finally {
    store.close();
  }
}
async function benchmark(directory: string, count: number) {
  const context = Array.from(
    { length: 120 },
    (_value, index) =>
      `<p id="context-${index}">Unrelated context ${index}: ${"ordinary planning text ".repeat(8)}</p>`,
  ).join("\n");
  const document = base.replace("</body>", `${context}</body>`);
  const rawPath = join(directory, `current-${count}.db`),
    semanticPath = join(directory, `semantic-${count}.db`);
  const current = new PlanStore(rawPath),
    semantic = new SemanticHistory(semanticPath, 20);
  const rawLatencies: number[] = [],
    semanticLatencies: number[] = [];
  let rawSnapshot = current.snapshot("benchmark");
  current.command("benchmark", {
    kind: "html",
    requestId: "seed",
    actor: actors[0],
    baseHtmlRevision: rawSnapshot.htmlRevision,
    html: document,
  });
  rawSnapshot = current.snapshot("benchmark");
  semantic.create("benchmark", document);
  let expected = "Budget 0";
  try {
    for (let index = 1; index <= count; index++) {
      const text = `Budget ${index}`;
      const raw = measure(() =>
        current.command("benchmark", {
          kind: "html",
          requestId: `change-${index}`,
          actor: actors[0],
          baseHtmlRevision: rawSnapshot.htmlRevision,
          html: rawSnapshot.html.replace(expected, text),
        }),
      );
      if (raw.result.status !== 200) throw new Error("Sequential current-store edit conflicted.");
      rawLatencies.push(raw.ms);
      rawSnapshot = current.snapshot("benchmark");
      const proposed = measure(() =>
        semantic.propose("benchmark", {
          id: `change-${index}`,
          branch: "main",
          parentRevision: semantic.head("benchmark"),
          actor: actors[0],
          reason: "Update the budget projection.",
          operation: { kind: "replace-text", nodeId: "budget", expectedText: expected, text },
        }),
      );
      semanticLatencies.push(proposed.ms);
      expected = text;
    }
    const readRevision = Math.max(1, count - 1);
    const checkpointRead = measure(() => semantic.read("benchmark", readRevision));
    const replayRead = measure(() => semantic.read("benchmark", readRevision, false));
    if (JSON.stringify(checkpointRead.result) !== JSON.stringify(replayRead.result))
      throw new Error("Checkpoint and full replay disagree.");
    const currentRead = measure(() => current.version("benchmark", rawSnapshot.revision - 1));
    const footprint = semantic.footprint();
    const result = {
      count,
      htmlBytes: Buffer.byteLength(document),
      current: {
        medianWriteMs: median(rawLatencies),
        historyReadMs: currentRead.ms,
        retainedLogicalBytes: retainedLegacyBytes(rawPath),
      },
      semantic: {
        medianWriteMs: median(semanticLatencies),
        checkpointReadMs: checkpointRead.ms,
        fullReplayMs: replayRead.ms,
        readRevision,
        footprint,
      },
    };
    current.close();
    semantic.close();
    return {
      ...result,
      retainedDatabaseBytes: {
        current: (await stat(rawPath)).size,
        semantic: (await stat(semanticPath)).size,
      },
    };
  } catch (error) {
    current.close();
    semantic.close();
    throw error;
  }
}

const directory = await mkdtemp(join(tmpdir(), "plan-web-semantic-demo-"));
try {
  const lengths = process.env.PLAN_WEB_SEMANTIC_LENGTHS?.split(",").map(Number) ?? [100, 1000];
  if (lengths.some((count) => !Number.isSafeInteger(count) || count < 2 || count > 5000))
    throw new Error("Benchmark history lengths must be between 2 and 5000.");
  const report = {
    comparison: comparison(directory),
    branches: branchComparison(directory),
    benchmarks: await Promise.all(lengths.map((count) => benchmark(directory, count))),
  };
  const output = process.argv[2];
  if (output) {
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Comparison saved to ${output}`);
  } else console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
