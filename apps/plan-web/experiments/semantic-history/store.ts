import { DatabaseSync } from "node:sqlite";
import type { Actor } from "../../src/contracts.ts";
import {
  applyEdit,
  applyResolution,
  initialState,
  type Change,
  type Operation,
  type State,
} from "./model.ts";

export type Proposal = {
  id: string;
  branch: string;
  parentRevision: number;
  actor: Actor;
  reason: string;
  operation: Operation;
};
export type Receipt = {
  id: string;
  revision: number;
  branch: string;
  outcome: "applied" | "conflict";
  conflictIds: string[];
};
type Branch = { name: string; created_from: number; head: number };
type ChangeRow = { revision: number; document: string; fingerprint: string; receipt: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Proposal must contain JSON values.");
  return encoded;
}

export class SemanticHistory {
  private db: DatabaseSync;
  readonly checkpointEvery: number;
  constructor(path: string, checkpointEvery = 20) {
    this.checkpointEvery = checkpointEvery;
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 1)
      throw new Error("Checkpoint interval must be positive.");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS semantic_plans(name TEXT PRIMARY KEY, initial_html TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS semantic_branches(plan TEXT NOT NULL REFERENCES semantic_plans(name), name TEXT NOT NULL,
        created_from INTEGER NOT NULL, head INTEGER NOT NULL, PRIMARY KEY(plan,name));
      CREATE TABLE IF NOT EXISTS semantic_changes(plan TEXT NOT NULL REFERENCES semantic_plans(name), revision INTEGER NOT NULL,
        id TEXT NOT NULL, document TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(plan,revision), UNIQUE(plan,id));
      CREATE TABLE IF NOT EXISTS semantic_checkpoints(plan TEXT NOT NULL REFERENCES semantic_plans(name), revision INTEGER NOT NULL,
        reducer_version INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(plan,revision));
      CREATE TRIGGER IF NOT EXISTS semantic_changes_no_update BEFORE UPDATE ON semantic_changes BEGIN SELECT RAISE(ABORT, 'Accepted changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS semantic_changes_no_delete BEFORE DELETE ON semantic_changes BEGIN SELECT RAISE(ABORT, 'Accepted changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS semantic_initial_no_update BEFORE UPDATE ON semantic_plans BEGIN SELECT RAISE(ABORT, 'Initial plan bytes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS semantic_checkpoint_no_update BEFORE UPDATE ON semantic_checkpoints BEGIN SELECT RAISE(ABORT, 'Checkpoints are immutable'); END;`);
  }
  close() {
    this.db.close();
  }
  create(name: string, html: string) {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM semantic_plans WHERE name=?").get(name))
        throw new Error("Plan already exists.");
      this.db.prepare("INSERT INTO semantic_plans VALUES (?,?)").run(name, html);
      this.db.prepare("INSERT INTO semantic_branches VALUES (?, 'main', 0, 0)").run(name);
      this.db
        .prepare("INSERT INTO semantic_checkpoints VALUES (?,0,1,?)")
        .run(name, JSON.stringify(initialState(html)));
    });
  }
  branch(name: string, branch: string, from: number) {
    this.transaction(() => {
      this.read(name, from);
      this.db
        .prepare("INSERT INTO semantic_branches VALUES (?,?,?,?)")
        .run(name, branch, from, from);
    });
    return this.head(name, branch);
  }
  head(name: string, branch = "main") {
    const record = this.db
      .prepare("SELECT name,created_from,head FROM semantic_branches WHERE plan=? AND name=?")
      .get(name, branch) as Branch | undefined;
    if (!record) throw new Error("Branch does not exist.");
    return record.head;
  }
  change(name: string, revision: number): Change {
    const row = this.db
      .prepare("SELECT document FROM semantic_changes WHERE plan=? AND revision=?")
      .get(name, revision) as { document: string } | undefined;
    if (!row) throw new Error("Revision does not exist.");
    const change = JSON.parse(row.document) as Change;
    if (change.reducerVersion !== 1) throw new Error("Unsupported reducer version.");
    return change;
  }
  read(name: string, revision = this.head(name), checkpoints = true): State {
    const memo = new Map<number, State>();
    const replay = (at: number): State => {
      const found = memo.get(at);
      if (found) return found;
      if (checkpoints) {
        const checkpoint = this.db
          .prepare(
            "SELECT reducer_version,state FROM semantic_checkpoints WHERE plan=? AND revision=?",
          )
          .get(name, at) as { reducer_version: number; state: string } | undefined;
        if (checkpoint) {
          if (checkpoint.reducer_version !== 1)
            throw new Error("Unsupported checkpoint reducer version.");
          const state = JSON.parse(checkpoint.state) as State;
          memo.set(at, state);
          return state;
        }
      }
      if (at === 0) {
        const plan = this.db
          .prepare("SELECT initial_html FROM semantic_plans WHERE name=?")
          .get(name) as { initial_html: string } | undefined;
        if (!plan) throw new Error("Plan does not exist.");
        return initialState(plan.initial_html);
      }
      const change = this.change(name, at);
      const previous = replay(change.parents[0]);
      const state = this.reduce(name, previous, change, replay);
      memo.set(at, state);
      return state;
    };
    return structuredClone(replay(revision));
  }
  private reduce(
    name: string,
    previous: State,
    change: Change,
    read: (revision: number) => State,
  ): State {
    const op = change.operation;
    if (op.kind === "restore") return structuredClone(read(op.revision));
    if (op.kind === "resolve") return applyResolution(previous, change, op);
    if (op.kind === "merge") {
      let result = previous;
      for (const revision of op.revisions)
        result = this.reduce(name, result, this.change(name, revision), read);
      return result;
    }
    return applyEdit(previous, change, op);
  }
  private ancestors(name: string, revision: number) {
    const seen = new Set<number>();
    const remaining = [revision];
    while (remaining.length) {
      const current = remaining.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (current) remaining.push(...this.change(name, current).parents);
    }
    return seen;
  }
  propose(name: string, proposal: Proposal): Receipt {
    return this.transaction(() => {
      const fingerprint = canonical(proposal);
      const existing = this.db
        .prepare("SELECT fingerprint,receipt FROM semantic_changes WHERE plan=? AND id=?")
        .get(name, proposal.id) as ChangeRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Change ID already has a different proposal.");
        return JSON.parse(existing.receipt) as Receipt;
      }
      const head = this.head(name, proposal.branch);
      if (!this.ancestors(name, head).has(proposal.parentRevision))
        throw new Error("Parent revision is not an ancestor of this branch.");
      const latest = this.db
        .prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM semantic_changes WHERE plan=?")
        .get(name) as { revision: number };
      const revision = latest.revision + 1;
      if (!proposal.id || !proposal.actor.id || !proposal.reason || proposal.reason.length > 2000)
        throw new Error("Change identity and bounded reason are required.");
      const parents = [head];
      if (proposal.operation.kind === "restore") {
        if (!this.ancestors(name, proposal.parentRevision).has(proposal.operation.revision))
          throw new Error("Restore revision is not in branch history.");
      }
      if (proposal.operation.kind === "merge")
        throw new Error("Use merge() to derive branch ancestry.");
      const change: Change = {
        ...proposal,
        revision,
        parents,
        reducerVersion: 1,
        createdAt: Date.now(),
      };
      const operation = proposal.operation;
      const parent = this.read(name, proposal.parentRevision);
      if (operation.kind === "resolve") applyResolution(parent, change, operation);
      else if (operation.kind !== "restore") {
        const validated = applyEdit(parent, change, operation);
        if (validated.conflicts[`conflict-${change.id}`])
          throw new Error("Operation does not match parent revision.");
      }
      return this.append(name, change, fingerprint);
    });
  }
  merge(
    name: string,
    target: string,
    source: string,
    identity: Omit<Proposal, "branch" | "parentRevision" | "operation">,
  ): Receipt {
    return this.transaction(() => {
      // The branch names and request identity are stable even after either pointer advances.
      const fingerprint = canonical({ target, source, ...identity });
      const existing = this.db
        .prepare("SELECT fingerprint,receipt FROM semantic_changes WHERE plan=? AND id=?")
        .get(name, identity.id) as ChangeRow | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Change ID already has a different proposal.");
        return JSON.parse(existing.receipt) as Receipt;
      }
      if (!identity.id || !identity.actor.id || !identity.reason || identity.reason.length > 2000)
        throw new Error("Change identity and bounded reason are required.");
      if (target === source) throw new Error("Merge branches must differ.");
      const targetHead = this.head(name, target),
        sourceHead = this.head(name, source);
      const targetAncestors = this.ancestors(name, targetHead);
      const revisions = [...this.ancestors(name, sourceHead)]
        .filter(
          (at) =>
            at !== 0 &&
            !targetAncestors.has(at) &&
            this.change(name, at).operation.kind !== "merge",
        )
        .sort((a, b) => a - b);
      const latest = this.db
        .prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM semantic_changes WHERE plan=?")
        .get(name) as { revision: number };
      const change: Change = {
        ...identity,
        branch: target,
        parentRevision: targetHead,
        revision: latest.revision + 1,
        parents: [targetHead, sourceHead],
        operation: { kind: "merge", revisions },
        reducerVersion: 1,
        createdAt: Date.now(),
      };
      return this.append(name, change, fingerprint);
    });
  }
  private append(name: string, change: Change, fingerprint: string): Receipt {
    const previous = this.read(name, change.parents[0]);
    const state = this.reduce(name, previous, change, (at) => this.read(name, at));
    const conflictIds = Object.keys(state.conflicts).filter(
      (id) => !previous.conflicts[id] && state.conflicts[id].status === "unresolved",
    );
    const receipt: Receipt = {
      id: change.id,
      revision: change.revision,
      branch: change.branch,
      outcome: conflictIds.length ? "conflict" : "applied",
      conflictIds,
    };
    this.db
      .prepare("INSERT INTO semantic_changes VALUES (?,?,?,?,?,?)")
      .run(
        name,
        change.revision,
        change.id,
        JSON.stringify(change),
        fingerprint,
        JSON.stringify(receipt),
      );
    this.db
      .prepare("UPDATE semantic_branches SET head=? WHERE plan=? AND name=?")
      .run(change.revision, name, change.branch);
    if (change.revision % this.checkpointEvery === 0)
      this.db
        .prepare("INSERT INTO semantic_checkpoints VALUES (?,?,1,?)")
        .run(name, change.revision, JSON.stringify(state));
    return receipt;
  }
  history(name: string, branch = "main") {
    return [...this.ancestors(name, this.head(name, branch))]
      .filter(Boolean)
      .sort((a, b) => a - b)
      .map((at) => this.change(name, at));
  }
  footprint() {
    const row = this.db
      .prepare(`SELECT
      (SELECT COALESCE(SUM(length(CAST(document AS BLOB))+length(CAST(fingerprint AS BLOB))+length(CAST(receipt AS BLOB))),0) FROM semantic_changes) AS eventBytes,
      (SELECT COALESCE(SUM(length(CAST(state AS BLOB))),0) FROM semantic_checkpoints) AS checkpointBytes,
      (SELECT COUNT(*) FROM semantic_changes) AS events,
      (SELECT COUNT(*) FROM semantic_checkpoints) AS checkpoints,
      (SELECT COUNT(*) FROM semantic_branches) AS branches`)
      .get() as {
      eventBytes: number;
      checkpointBytes: number;
      events: number;
      checkpoints: number;
      branches: number;
    };
    return row;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
