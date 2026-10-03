import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlanStore } from "../apps/plan-web/src/backend/store.ts";
import {
  SemanticHistory,
  type Proposal,
} from "../apps/plan-web/experiments/semantic-history/store.ts";
import {
  applyEdit,
  initialState,
  type Change,
} from "../apps/plan-web/experiments/semantic-history/model.ts";

const html = `<!doctype html><html><head><style>p { color: blue; }</style><script>window.keep = "<p id='fake'>";</script></head><body>
<h1 id="heading">Storage</h1><p id="database">Use PostgreSQL.</p><p id="budget">Budget 0</p><!-- keep exact spacing -->
</body></html>`;
const actor = { id: "agent-a", name: "Agent A", kind: "agent" as const };
const edit = (id: string, parentRevision = 0, text = "Use SQLite."): Proposal => ({
  id,
  branch: "main",
  parentRevision,
  actor,
  reason: "Reduce the number of services to operate.",
  operation: { kind: "replace-text", nodeId: "database", expectedText: "Use PostgreSQL.", text },
});
async function fixture(
  work: (store: SemanticHistory, path: string) => Promise<void> | void,
  checkpointEvery = 2,
) {
  const directory = await mkdtemp(join(tmpdir(), "plan-web-semantic-"));
  const path = join(directory, "experiment.db");
  const store = new SemanticHistory(path, checkpointEvery);
  try {
    store.create("plan", html);
    await work(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const permutations = <T>(items: T[]): T[][] =>
  items.length === 0
    ? [[]]
    : items.flatMap((item, i) =>
        permutations(items.filter((_value, j) => i !== j)).map((tail) => [item, ...tail]),
      );

test("all arrival orders retain independent work and both competing agent choices with intent", async () => {
  for (const order of permutations(["a", "b", "c"]))
    await fixture((store) => {
      const proposals: Record<string, Proposal> = {
        a: edit("a"),
        b: {
          ...edit("b", 0, "Use DynamoDB."),
          actor: { id: "agent-b", name: "Agent B", kind: "agent" },
          reason: "Avoid managing database infrastructure.",
        },
        c: {
          ...edit("c"),
          actor: { id: "agent-c", name: "Agent C", kind: "agent" },
          reason: "Record deployment context.",
          operation: {
            kind: "insert-after",
            nodeId: "database",
            html: '<section id="deployment">PostgreSQL deployment context.</section>',
          },
        },
      };
      const receipts = order.map((key) => store.propose("plan", proposals[key]));
      const state = store.read("plan");
      expect(state.html).toContain('id="deployment">PostgreSQL deployment context.');
      expect(receipts.filter((receipt) => receipt.outcome === "conflict")).toHaveLength(1);
      const conflict = Object.values(state.conflicts)[0];
      expect(new Set(conflict.competingChanges)).toEqual(new Set(["a", "b"]));
      expect(conflict.status).toBe("unresolved");
      expect(
        store
          .history("plan")
          .map((change) => change.id)
          .sort(),
      ).toEqual(["a", "b", "c"]);
      expect(store.history("plan").find((change) => change.id === "b")?.reason).toBe(
        "Avoid managing database infrastructure.",
      );
      expect(store.read("plan", store.head("plan"), false)).toEqual(state);
    });
});

test("conflict resolution is a new durable change and survives another store connection", async () => {
  await fixture((store, path) => {
    store.propose("plan", edit("a"));
    const conflict = store.propose("plan", edit("b", 0, "Use DynamoDB."));
    const resolution = store.propose("plan", {
      ...edit("resolution", store.head("plan")),
      reason: "Choose SQLite for the standalone version.",
      operation: {
        kind: "resolve",
        conflictId: conflict.conflictIds[0],
        text: "Use SQLite for v1; reconsider managed storage later.",
      },
    });
    const reopened = new SemanticHistory(path);
    try {
      expect(reopened.read("plan").html).toContain(
        "Use SQLite for v1; reconsider managed storage later.",
      );
      expect(reopened.read("plan").conflicts[conflict.conflictIds[0]].resolution).toEqual({
        changeId: "resolution",
        actor,
        text: "Use SQLite for v1; reconsider managed storage later.",
      });
      expect(reopened.history("plan")).toHaveLength(3);
      expect(reopened.change("plan", resolution.revision).parents).toEqual([conflict.revision]);
    } finally {
      reopened.close();
    }
  });
});

test("logical forks share revisions; merging branches preserves alternatives and both parents", async () => {
  await fixture((store) => {
    store.branch("plan", "sqlite", 0);
    store.branch("plan", "dynamo", 0);
    expect(store.footprint().events).toBe(0);
    const a = store.propose("plan", { ...edit("a"), branch: "sqlite" });
    const b = store.propose("plan", { ...edit("b", 0, "Use DynamoDB."), branch: "dynamo" });
    expect(store.read("plan", a.revision).html).toContain("Use SQLite.");
    expect(store.read("plan", b.revision).html).toContain("Use DynamoDB.");
    const identity = { id: "merge-a", actor, reason: "Review the SQLite alternative." };
    store.merge("plan", "main", "sqlite", identity);
    const merged = store.merge("plan", "main", "dynamo", {
      ...identity,
      id: "merge-b",
      reason: "Compare competing storage choices.",
    });
    expect(merged.outcome).toBe("conflict");
    expect(store.change("plan", merged.revision).parents).toEqual([3, b.revision]);
    expect(store.history("plan").map((change) => change.id)).toEqual([
      "a",
      "b",
      "merge-a",
      "merge-b",
    ]);
    expect(store.read("plan", merged.revision, false)).toEqual(store.read("plan"));
    expect(store.head("plan", "sqlite")).toBe(a.revision);
    expect(store.head("plan", "dynamo")).toBe(b.revision);
    const before = store.read("plan");
    store.merge("plan", "main", "dynamo", { ...identity, id: "merge-again" });
    expect(store.read("plan")).toEqual(before);
  });
});

test("idempotent retries keep their receipt after branch heads advance and reject payload changes", async () => {
  await fixture((store) => {
    const proposal = edit("stable-id");
    const first = store.propose("plan", proposal);
    store.propose("plan", {
      ...edit("second", first.revision, "Use PostgreSQL again."),
      operation: {
        kind: "replace-text",
        nodeId: "database",
        expectedText: "Use SQLite.",
        text: "Use PostgreSQL again.",
      },
    });
    expect(store.propose("plan", proposal)).toEqual(first);
    expect(store.footprint().events).toBe(2);
    expect(() =>
      store.propose("plan", { ...proposal, reason: "Changed request under the same ID." }),
    ).toThrow("different proposal");
    expect(store.read("plan").html).toContain("Use PostgreSQL again.");
  });
});

test("restoring an old revision appends history without deleting later changes", async () => {
  await fixture((store) => {
    const first = store.propose("plan", edit("edit"));
    const restored = store.propose("plan", {
      ...edit("restore", first.revision),
      reason: "Return to the original plan for review.",
      operation: { kind: "restore", revision: 0 },
    });
    expect(restored.revision).toBeGreaterThan(first.revision);
    expect(store.read("plan").html).toBe(html);
    expect(store.read("plan", first.revision).html).toContain("Use SQLite.");
    expect(store.history("plan")).toHaveLength(2);
    expect(store.read("plan", restored.revision, false)).toEqual(store.read("plan"));
  });
});

test("valid concurrent deletions and duplicate insertions retain conflicts; invalid parent context is rejected", async () => {
  await fixture((store) => {
    const original = '<p id="database">Use PostgreSQL.</p>';
    store.propose("plan", edit("edit"));
    const removed = store.propose("plan", {
      ...edit("delete"),
      reason: "Remove the superseded decision.",
      operation: { kind: "delete-node", nodeId: "database", expectedHtml: original },
    });
    expect(removed.outcome).toBe("conflict");
    expect(store.read("plan").html).toContain("Use SQLite.");
    const insertion: Proposal = {
      ...edit("insert"),
      operation: { kind: "insert-after", nodeId: "database", html: '<p id="new">New block</p>' },
    };
    store.propose("plan", insertion);
    expect(store.propose("plan", { ...insertion, id: "duplicate" }).outcome).toBe("conflict");
    expect(() =>
      store.propose("plan", {
        ...edit("wrong-context"),
        operation: {
          kind: "replace-text",
          nodeId: "database",
          expectedText: "Use SQLite.",
          text: "Use DynamoDB.",
        },
      }),
    ).toThrow("does not match parent");
    expect(() =>
      store.propose("plan", {
        ...edit("missing", store.head("plan")),
        operation: {
          kind: "replace-text",
          nodeId: "missing",
          expectedText: "",
          text: "Lost target",
        },
      }),
    ).toThrow("does not match parent");
    const beforeDelete = store.head("plan");
    store.propose("plan", {
      ...edit("delete-budget", beforeDelete),
      operation: {
        kind: "delete-node",
        nodeId: "budget",
        expectedHtml: '<p id="budget">Budget 0</p>',
      },
    });
    expect(
      store.propose("plan", {
        ...edit("edit-deleted", beforeDelete),
        operation: {
          kind: "replace-text",
          nodeId: "budget",
          expectedText: "Budget 0",
          text: "Budget 1",
        },
      }).outcome,
    ).toBe("conflict");
    expect(Object.values(store.read("plan").conflicts)).toHaveLength(3);
  });
});

test("authored scripts, styles, entities and opaque markup keep their original bytes outside targeted text", async () => {
  const arbitrary =
    '<!doctype html>\n<!-- untouched -->\n<html><head><style>p::before { content: "<a>" }</style><script>const s = "<p id=\\\"fake\\\">";</script></head><body><custom-plan data-url="x?a=1&b=2"><p id="choice" class=\'x\'>Old &amp; value</p><template><p id="inside">opaque</p></template></custom-plan>\n</body></html>';
  const change: Change = {
    ...edit("opaque"),
    revision: 1,
    parents: [0],
    reducerVersion: 1,
    createdAt: 123,
    operation: {
      kind: "replace-text",
      nodeId: "choice",
      expectedText: "Old & value",
      text: "New < & value",
    },
  };
  const state = applyEdit(
    initialState(arbitrary),
    change,
    change.operation as Extract<typeof change.operation, { kind: "replace-text" }>,
  );
  expect(state.html).toBe(arbitrary.replace("Old &amp; value", "New &lt; &amp; value"));
  const duplicate = arbitrary.replace('id="choice"', 'id="inside"');
  const unchanged = applyEdit(initialState(duplicate), change, {
    kind: "replace-text",
    nodeId: "inside",
    expectedText: "Old & value",
    text: "New",
  });
  expect(unchanged.html).toBe(duplicate);
  expect(Object.values(unchanged.conflicts)).toHaveLength(1);
});

test("seeded independent changes commute and checkpoint replay equals full history across retries", async () => {
  let seed = 417;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let round = 0; round < 80; round++) {
    const a: Change = {
      ...edit(`a-${round}`),
      revision: 1,
      parents: [0],
      reducerVersion: 1,
      createdAt: 123,
      operation: {
        kind: "replace-text",
        nodeId: "database",
        expectedText: "Use PostgreSQL.",
        text: `Choice ${random()}`,
      },
    };
    const b: Change = {
      ...edit(`b-${round}`),
      revision: 2,
      parents: [0],
      reducerVersion: 1,
      createdAt: 123,
      operation: {
        kind: "replace-text",
        nodeId: "budget",
        expectedText: "Budget 0",
        text: `Budget ${random()}`,
      },
    };
    const first = applyEdit(
      applyEdit(
        initialState(html),
        a,
        a.operation as Extract<Change["operation"], { kind: "replace-text" }>,
      ),
      b,
      b.operation as Extract<Change["operation"], { kind: "replace-text" }>,
    );
    const second = applyEdit(
      applyEdit(
        initialState(html),
        b,
        b.operation as Extract<Change["operation"], { kind: "replace-text" }>,
      ),
      a,
      a.operation as Extract<Change["operation"], { kind: "replace-text" }>,
    );
    expect(first).toEqual(second);
  }
  await fixture((store) => {
    let text = "Use PostgreSQL.";
    for (let index = 1; index <= 70; index++) {
      const next = `Choice ${random()}`;
      const proposal: Proposal = {
        ...edit(`sequence-${index}`, store.head("plan")),
        operation: { kind: "replace-text", nodeId: "database", expectedText: text, text: next },
      };
      const receipt = store.propose("plan", proposal);
      expect(store.propose("plan", proposal)).toEqual(receipt);
      expect(store.read("plan", receipt.revision, false)).toEqual(store.read("plan"));
      text = next;
    }
    expect(store.footprint().events).toBe(70);
    expect(store.footprint().checkpoints).toBe(36);
  });
});

test("accepted history is immutable and unknown reducer versions refuse replay", async () => {
  await fixture((store, path) => {
    const receipt = store.propose("plan", edit("version"));
    const original = store.change("plan", receipt.revision);
    const db = new DatabaseSync(path);
    try {
      expect(() =>
        db
          .prepare("UPDATE semantic_changes SET document='{}' WHERE revision=?")
          .run(receipt.revision),
      ).toThrow("immutable");
      expect(() =>
        db.prepare("DELETE FROM semantic_changes WHERE revision=?").run(receipt.revision),
      ).toThrow("immutable");
      const future = {
        ...original,
        id: "future-version",
        revision: receipt.revision + 1,
        reducerVersion: 999,
      };
      db.prepare("INSERT INTO semantic_changes VALUES (?,?,?,?,?,?)").run(
        "plan",
        future.revision,
        future.id,
        JSON.stringify(future),
        "future",
        "{}",
      );
    } finally {
      db.close();
    }
    expect(store.change("plan", receipt.revision)).toEqual(original);
    expect(() => store.read("plan", receipt.revision + 1, false)).toThrow(
      "Unsupported reducer version",
    );
  });
});

test("block-level replacement deliberately conflicts on independent words that the current text merger accepts", async () => {
  await fixture((store, path) => {
    const initial = '<p id="budget">Budget 0 and deadline Friday.</p>';
    store.create("tradeoff", initial);
    const current = new PlanStore(`${path}.current`);
    try {
      const seed = current.snapshot("tradeoff");
      current.command("tradeoff", {
        kind: "html",
        requestId: "seed",
        actor,
        baseHtmlRevision: seed.htmlRevision,
        html: initial,
      });
      const baseRevision = current.snapshot("tradeoff").htmlRevision;
      const proposals = [
        { id: "budget", text: "Budget 1 and deadline Friday." },
        { id: "deadline", text: "Budget 0 and deadline Monday." },
      ];
      const semantic = proposals.map(({ id, text }) =>
        store.propose("tradeoff", {
          ...edit(id),
          operation: {
            kind: "replace-text",
            nodeId: "budget",
            expectedText: "Budget 0 and deadline Friday.",
            text,
          },
        }),
      );
      const raw = proposals.map(({ id, text }) =>
        current.command("tradeoff", {
          kind: "html",
          requestId: id,
          actor,
          baseHtmlRevision: baseRevision,
          html: initial.replace("Budget 0 and deadline Friday.", text),
        }),
      );
      expect(raw.map((outcome) => outcome.status)).toEqual([200, 200]);
      expect(current.snapshot("tradeoff").html).toContain("Budget 1 and deadline Monday.");
      expect(semantic.map((receipt) => receipt.outcome)).toEqual(["applied", "conflict"]);
      expect(store.history("tradeoff")).toHaveLength(2);
    } finally {
      current.close();
    }
  });
});
