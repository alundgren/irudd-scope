import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { decode, ScopeError } from "@irudd-scope/protocol";
import {
  LibrarianCommand,
  LibrarianHumanCommand,
  LibrarianRoutineWork,
  MemoryChange,
  type LibrarianFilters,
  type LibrarianReply,
  type LibrarianView,
  type LibrarianRun,
  type LibrarianProposal,
} from "@irudd-scope/protocol/librarian";
import { MemoryCommands } from "@irudd-scope/memory-sync/commands";
import type { DesktopStore } from "./desktop-store.ts";
import type { MemoryService } from "./memory.ts";
import {
  MemoryConcept,
  MemoryList,
  MemorySearch,
  memoryFields,
  type MemoryChanges,
  type MemoryChangeSummary,
  type MemoryFacets,
  type MemoryListPage,
  type MemorySummary,
} from "./plugins/memory/contract.ts";

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Document = Mutable<LibrarianView>;
const mutable = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;

function cli<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema)(input);
}
const WEEK = 7 * 24 * 60 * 60_000;
/** Keeps the irudd-okf error code so a caller can react to one specific refusal. */
class OkfFailure extends ScopeError {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(409, message);
  }
}
const Inspection = Schema.Struct({
  version: Schema.Literal(1),
  bundle: Schema.String,
  name: Schema.String,
  cliVersion: Schema.String,
  id: Schema.NullOr(Schema.String),
  root: Schema.String,
  formatVersion: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["current", "migration-required", "newer", "invalid"]),
  supportedFormatVersion: Schema.Number,
});
const Browse = Schema.Struct({
  version: Schema.Literal(1),
  bundle: Schema.String,
  path: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["directory", "memory"]),
      title: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(Schema.String),
    }),
  ),
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
  total: Schema.optionalKey(Schema.Number),
  truncated: Schema.Boolean,
});
const ChangeList = Schema.Struct({
  version: Schema.Literal(1),
  changes: Schema.Array(MemoryChange),
  total: Schema.Number,
});
type Selection = Omit<
  Extract<LibrarianHumanCommand, { action: "navigate" }>,
  "action" | "requestId" | "expectedUiRevision"
>;
const OUTPUT_LIMIT = "Memory command output exceeds";
/** Bounds how much recorded history one path scan reads; the UI reports when it stops early. */
const SCAN_LIMIT = 1000;
const SEARCH_LIMIT = 300;

function matches(concept: MemorySummary, filters: LibrarianFilters) {
  const memory = memoryFields(concept.memory);
  return (
    (!filters.tag || concept.tags.includes(filters.tag)) &&
    (!filters.stage || (memory.stage ?? "none") === filters.stage) &&
    (!filters.kind || memory.kind === filters.kind) &&
    (!filters.applicability || memory.applicability?.type === filters.applicability)
  );
}
const filtered = (filters: LibrarianFilters | undefined) =>
  !!filters && Object.values(filters).some((value) => value !== undefined);
function counted(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
function facets(concepts: readonly MemorySummary[]): MemoryFacets {
  const fields = concepts.map((concept) => memoryFields(concept.memory));
  const tags = counted(concepts.flatMap((concept) => [...new Set(concept.tags)]));
  return {
    tags: tags.slice(0, 50),
    tagTotal: tags.length,
    kinds: counted(fields.flatMap((field) => (field.kind ? [field.kind] : []))),
    stages: counted(fields.map((field) => field.stage ?? "none")),
    applicability: counted(fields.flatMap((field) => field.applicability?.type ?? [])),
  };
}
const byTitle = (a: MemorySummary, b: MemorySummary) =>
  a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
export function changeSummary(change: MemoryChange): MemoryChangeSummary {
  const before = memoryFields(change.display?.beforeMemory).stage;
  const after = memoryFields(change.display?.afterMemory).stage;
  const reviews = change.reviews ?? (change.review ? [change.review] : []);
  return {
    id: change.id,
    path: change.path,
    ...(change.display?.title ? { title: change.display.title.slice(0, 4096) } : {}),
    action: change.action,
    status: change.status,
    createdAt: change.createdAt,
    actor: change.actor,
    decidedBy: reviews.map((review) => ({
      actor: review.actor,
      decision: review.decision,
      at: review.at,
    })),
    reason: change.reason.length > 280 ? `${change.reason.slice(0, 279)}…` : change.reason,
    ...(before && after && before !== after ? { stageChange: { from: before, to: after } } : {}),
  };
}

/** Stores presentation and human decisions. File semantics belong to irudd-okf. */
export class LibrarianService {
  private capability?: { runId: string; sessionId: string; token: string };
  private pending = Promise.resolve();
  private commands: MemoryCommands;
  constructor(
    private store: DesktopStore,
    private memory: MemoryService,
    private changed: (state: LibrarianView) => void = () => {},
    options: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
  ) {
    this.commands = new MemoryCommands(options.env);
    this.now = options.now ?? (() => new Date());
  }
  private now: () => Date;

  async start() {
    await this.store.preserveMemoryPreferences();
    const state = await this.read();
    if (state.run?.status === "active") {
      state.run.status = "interrupted";
      state.uiRevision++;
    }
    await this.store.saveLibrarian(state);
  }
  async read(): Promise<Document> {
    return mutable(await this.store.librarian());
  }
  async projected() {
    return this.project(await this.read());
  }
  private project(state: Document): LibrarianView {
    const inspected = state.historyRunId
      ? state.history.find((run) => run.id === state.historyRunId)
      : state.run;
    const completed = inspected?.proposals.filter((p) => p.change.status !== "pending") ?? [];
    return {
      ...state,
      ...(state.run
        ? {
            run: {
              ...state.run,
              proposals: state.run.proposals.filter((p) => p.change.id === state.selectedChangeId),
            },
          }
        : {}),
      history: state.history.slice(-10).map((run) => ({ ...run, proposals: [] })),
      pendingCount:
        state.run?.proposals.filter(
          (p) => p.disposition === "human" && p.change.status === "pending",
        ).length ?? 0,
      completedCount: completed.length,
      overview:
        state.view === "overview" && !state.selectedChangeId
          ? completed.slice(state.offset, state.offset + 10).map((p) => ({
              id: p.change.id,
              path: p.change.path,
              title: p.change.display?.title,
              status: p.change.status,
              actor: p.change.review?.actor.type ?? p.change.actor.type,
            }))
          : [],
    };
  }
  close() {
    this.capability = undefined;
    return this.pending;
  }
  private queue<T>(work: () => Promise<T>) {
    const next = this.pending.then(work);
    this.pending = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private connection(
    command: { runId: string; sessionId: string; capability: string },
    state: Document,
  ) {
    const active = this.capability;
    if (
      state.run?.status !== "active" ||
      state.run.id !== command.runId ||
      !active ||
      active.runId !== command.runId ||
      active.sessionId !== command.sessionId ||
      active.token !== command.capability
    )
      throw new ScopeError(
        403,
        "Ask your existing agent to resume this dreaming run and attach its session.",
      );
    return state.run;
  }
  private async inspection() {
    const inspection = cli(Inspection, await this.okf(["bundle", "inspect", "personal"]));
    if (inspection.status !== "current" || inspection.formatVersion !== 2 || !inspection.id)
      throw new ScopeError(
        409,
        inspection.status === "migration-required"
          ? "This bundle needs migration. Ask your agent to run the irudd-okf migration guide with this selected folder as an explicit bundle and review the required choices. Scope keeps its files unchanged."
          : "This bundle format is unavailable. Ask your agent to inspect this selected folder as an explicit bundle and check the installed CLI version.",
      );
    return { id: inspection.id, root: inspection.root, formatVersion: 2 as const };
  }
  private async assertBundle(run: LibrarianRun) {
    if (JSON.stringify(await this.inspection()) !== JSON.stringify(run.bundle))
      throw new ScopeError(
        409,
        "The selected bundle changed. Resume with the original bundle before continuing.",
      );
  }
  private async okf(args: string[], body?: unknown) {
    const status = await this.memory.read();
    const identity = status.configuration.repository ?? status.configuration.localRoot;
    if (!status.configuration.enabled || !identity)
      throw new ScopeError(409, "Choose a memory bundle in Settings.");
    let directory: string | undefined;
    try {
      if (body !== undefined) {
        directory = await mkdtemp(join(tmpdir(), "scope-librarian-"));
        const file = join(directory, "request.json");
        await writeFile(file, JSON.stringify(body), { mode: 0o600 });
        args = [...args, "--file", file, "--authorize-personal"];
      }
      const result = await this.memory.runOkf(identity, args);
      if (result.code !== 0) {
        if (result.stderr.startsWith(OUTPUT_LIMIT))
          throw new OkfFailure(
            "This memory read is larger than Scope can display. The library is unchanged.",
            "OUTPUT_LIMIT",
          );
        let message =
          "irudd-okf could not complete this operation. Retry after checking your bundle.";
        let code: string | undefined;
        try {
          const { error } = JSON.parse(result.stderr || result.stdout);
          message = error.message;
          if (typeof error.code === "string") code = error.code;
        } catch {}
        throw new OkfFailure(String(message).slice(0, 2048), code);
      }
      return JSON.parse(result.stdout) as unknown;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  private async list() {
    return cli(MemoryList, await this.okf(["list", "--scope", "personal", "--all-applicability"]))
      .concepts;
  }
  private async search(query: string, offset: number) {
    // Leading whitespace prevents a query beginning with a flag from becoming CLI input.
    return cli(
      MemorySearch,
      await this.okf([
        "search",
        ` ${query}`,
        "--scope",
        "personal",
        "--all-applicability",
        "--limit",
        "30",
        "--offset",
        String(offset),
      ]),
    );
  }
  /** The result page for the stored query, folder, filters and offset. */
  private async page(state: Document, concepts?: readonly MemorySummary[]) {
    const filters = state.browse?.filters;
    const query = state.query.trim();
    if (!filtered(filters)) {
      if (query) return this.search(query, state.offset);
      return cli(
        Browse,
        await this.okf([
          "browse",
          "personal",
          "--all-applicability",
          "--limit",
          "20",
          "--offset",
          String(state.offset),
          ...(state.directory ? ["--path", state.directory] : []),
        ]),
      );
    }
    const allowed = new Map(
      (concepts ?? (await this.list()))
        .filter((concept) => matches(concept, filters!))
        .map((concept) => [concept.path, concept]),
    );
    let ordered: (MemorySummary & { excerpt?: string })[] = [...allowed.values()].sort(byTitle);
    let searchLimited: MemoryListPage["searchLimited"];
    if (query) {
      // Search has no facet options, so its hits are intersected with the filtered library.
      const hits = new Map<string, string>();
      let total = 0;
      for (let offset = 0; offset < SEARCH_LIMIT; offset += 30) {
        const found = await this.search(query, offset);
        total = found.total;
        for (const hit of found.results) if (!hits.has(hit.path)) hits.set(hit.path, hit.excerpt);
        if (!found.truncated) break;
      }
      ordered = [...hits].flatMap(([path, excerpt]) => {
        const concept = allowed.get(path);
        return concept ? [{ ...concept, excerpt }] : [];
      });
      if (total > hits.size) searchLimited = { scanned: hits.size, total };
    }
    return {
      version: 1,
      filtered: true,
      query,
      results: ordered.slice(state.offset, state.offset + 30),
      total: ordered.length,
      offset: state.offset,
      limit: 30,
      truncated: state.offset + 30 < ordered.length,
      ...(searchLimited ? { searchLimited } : {}),
    } satisfies MemoryListPage;
  }
  private async changes(offset: number, limit: number) {
    return cli(
      ChangeList,
      await this.okf([
        "change",
        "list",
        "personal",
        "--limit",
        String(limit),
        "--offset",
        String(offset),
      ]),
    );
  }
  /**
   * Reads recorded changes newest first until enough match. irudd-okf lists oldest first, so pages
   * are taken from the end; a change recorded mid-scan can shift a page, which ids deduplicate.
   */
  private async scan(match: (change: MemoryChange) => boolean, wanted: number) {
    const total = (await this.changes(0, 1)).total;
    const items: MemoryChange[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let size = 50;
    while (scanned < total && scanned < SCAN_LIMIT && items.length < wanted) {
      const limit = Math.min(size, total - scanned, SCAN_LIMIT - scanned);
      let page;
      try {
        page = await this.changes(total - scanned - limit, limit);
      } catch (error) {
        // Recorded changes carry full file bytes, so a few large notes can exceed the output cap.
        if (error instanceof OkfFailure && error.code === "OUTPUT_LIMIT" && size > 5) {
          size = Math.max(5, Math.floor(size / 2));
          continue;
        }
        throw error;
      }
      for (const change of [...page.changes].reverse()) {
        if (seen.has(change.id)) continue;
        seen.add(change.id);
        if (items.length < wanted && match(change)) items.push(change);
      }
      scanned += limit;
    }
    return { items, scanned, total, partial: items.length < wanted && scanned < total };
  }
  private async navigate(state: Document, command: Selection) {
    if (["browse", "memory", "connections", "stages", "activity"].includes(command.view))
      state.bundle = await this.inspection();
    const prior = state.view === "browse" ? state.displayed : undefined;
    state.view = command.view;
    delete state.selectedPath;
    delete state.selectedChangeId;
    state.displayed = null;
    state.comparisonOpen = false;
    state.evidenceOpen = false;
    if (command.historyRunId) state.historyRunId = command.historyRunId;
    else delete state.historyRunId;
    if (command.returnChangeId) state.returnChangeId = command.returnChangeId;
    else delete state.returnChangeId;
    const browse = (state.browse ??= { filters: {}, trail: [] });
    if (command.filters) browse.filters = mutable(command.filters);
    if (command.section === null) delete browse.section;
    else if (command.section) browse.section = command.section;
    if (command.focusPath) state.focusPath = command.focusPath;
    if (command.connections) state.connections = mutable(command.connections);
    if (command.stages) state.stages = mutable(command.stages);
    if (command.activity) state.activity = mutable(command.activity);
    if (command.view === "memory") {
      if (!command.path) throw new ScopeError(400, "Choose a memory.");
      browse.trail = mutable(command.trail ?? []);
      state.selectedPath = command.path;
      state.focusPath = command.path;
      const concept = cli(
        MemoryConcept,
        await this.okf(["read", "personal", command.path, "--all-applicability"]),
      );
      const path = command.path;
      const changes =
        browse.section === "changes" ? await this.scan((c) => c.path === path, 20) : undefined;
      state.displayed = {
        ...concept,
        ...(changes
          ? {
              changes: {
                items: changes.items.map(changeSummary),
                scanned: changes.scanned,
                total: changes.total,
                partial: changes.partial,
              } satisfies MemoryChanges,
            }
          : {}),
      };
      if (command.offset !== undefined) {
        state.offset = browse.offset = command.offset;
        state.results = await this.page(state);
      } else if (prior) state.results = prior;
    } else if (command.view === "browse") {
      state.query = command.query ?? "";
      state.directory = command.directory ?? "";
      state.offset = browse.offset = command.offset ?? 0;
      let concepts: readonly MemorySummary[] | undefined;
      try {
        concepts = await this.list();
        state.facets = facets(concepts);
      } catch (error) {
        // Filters need the library list; plain folder browsing and search still work without it.
        if (filtered(browse.filters)) throw error;
        state.facets = {
          ...facets([]),
          unavailable: "Filters are unavailable because the library list could not be read.",
        } satisfies MemoryFacets;
      }
      state.displayed = await this.page(state, concepts);
    } else if (command.view === "decision") {
      const proposal =
        state.run?.proposals.find((p) => p.change.id === command.changeId) ??
        state.run?.proposals.find(
          (p) => p.disposition === "human" && p.change.status === "pending",
        );
      if (proposal) {
        state.selectedChangeId = proposal.change.id;
        state.displayed = proposal;
      }
    } else if (command.view === "overview" && command.changeId) {
      const proposal = [state.run, ...state.history]
        .filter(Boolean)
        .flatMap((run) => run!.proposals)
        .find((p) => p.change.id === command.changeId);
      if (!proposal) throw new ScopeError(404, "This completed change is unavailable.");
      state.selectedChangeId = command.changeId;
      state.displayed = proposal;
    } else if (command.view === "overview") {
      state.offset = command.offset ?? 0;
    }
  }
  private async add(state: Document, input: LibrarianProposal) {
    const proposal = mutable(input);
    const run = state.run!;
    if (proposal.change.humanRequired) proposal.disposition = "human";
    if (proposal.disposition === "automatic") {
      if (!proposal.permission || !run.automaticPermissions.includes(proposal.permission))
        throw new ScopeError(
          403,
          "This automatic change was not permitted when dreaming started. Present it for a human decision.",
        );
      if (proposal.change.status === "pending") {
        try {
          proposal.change = mutable(
            cli(
              MemoryChange,
              await this.okf(["change", "review", "personal", proposal.change.id], {
                expectedRevisionHash: proposal.change.revisionHash,
                decision: "accept",
                actor: { type: "agent", id: run.sessionId },
                reason: `${proposal.permission}: ${proposal.change.reason}`,
                sources: proposal.change.sources,
              }),
            ),
          );
        } catch (error) {
          // irudd-okf rechecks some removals at review time; the proposal already exists, so queue it for the person.
          if (!(error instanceof OkfFailure && error.code === "HUMAN_REVIEW_REQUIRED")) throw error;
          proposal.disposition = "human";
        }
      }
    }
    const existing = run.proposals.findIndex((p) => p.change.id === proposal.change.id);
    if (existing >= 0) {
      if (run.proposals[existing].change.revisionHash !== proposal.change.revisionHash)
        throw new ScopeError(409, "This proposal revision changed. Present a new change.");
      const prior = run.proposals[existing];
      if (
        prior.change.status !== "pending" &&
        (prior.evidence !== proposal.evidence ||
          prior.disposition !== proposal.disposition ||
          prior.permission !== proposal.permission)
      )
        throw new ScopeError(
          409,
          "Completed change evidence is retained. Propose a new amendment.",
        );
      run.proposals[existing] = proposal;
    } else run.proposals.push(proposal);
    let amendedSelection = false;
    for (const old of run.proposals) {
      if (
        old.change.id === proposal.change.id ||
        old.change.path !== proposal.change.path ||
        old.change.status !== "pending"
      )
        continue;
      old.change = mutable(
        cli(MemoryChange, await this.okf(["change", "read", "personal", old.change.id])),
      );
      if (old.change.status === "superseded" && old.change.id === state.selectedChangeId)
        amendedSelection = true;
    }
    if (proposal.disposition === "human" && proposal.change.status === "pending") {
      if (state.view === "decision" && (!state.selectedChangeId || amendedSelection)) {
        state.view = "decision";
        state.selectedChangeId = proposal.change.id;
        state.displayed = proposal;
        delete state.selectedPath;
      }
    }
    if (state.selectedChangeId === proposal.change.id) {
      if (
        state.view === "decision" &&
        (proposal.disposition !== "human" || proposal.change.status !== "pending")
      )
        await this.navigate(state, { view: "decision" });
      else state.displayed = proposal;
    }
  }
  command(input: unknown): Promise<LibrarianReply> {
    const command = decode(LibrarianCommand, input);
    return this.queue(async () => {
      if (command.action === "read") return { state: await this.projected() };
      if (command.action === "local") {
        if (!isAbsolute(command.root) || command.root.includes("\0"))
          throw new ScopeError(400, "Provide an absolute bundle location.");
        const root = resolve(command.root);
        if (command.initialize) {
          await mkdir(root, { recursive: true });
          if ((await readdir(root)).length)
            throw new ScopeError(
              409,
              "Initialize requires an empty folder. Existing bundles are never migrated automatically.",
            );
          const initialized = await this.commands.run("irudd-okf", ["init", root], { cwd: root });
          if (initialized.code !== 0)
            throw new ScopeError(409, "irudd-okf could not initialize this empty folder.");
        }
        const result = await this.commands.run(
          "irudd-okf",
          ["--bundle", `personal=${root}`, "bundle", "inspect", "personal"],
          { cwd: root },
        );
        if (result.code !== 0)
          throw new ScopeError(409, "irudd-okf could not inspect this folder.");
        const inspection = cli(Inspection, JSON.parse(result.stdout));
        if (inspection.status !== "current" || inspection.formatVersion !== 2 || !inspection.id)
          throw new ScopeError(
            409,
            "Migration needed. Ask your existing agent to run irudd-okf migration guide for this folder before connecting.",
          );
        await this.memory.connectLocal(root);
        const state = await this.read();
        if (state.run?.status === "active") state.run.status = "interrupted";
        this.capability = undefined;
        state.view = "browse";
        state.displayed = null;
        delete state.selectedPath;
        delete state.selectedChangeId;
        state.bundle = await this.inspection();
        state.uiRevision++;
        await this.store.saveLibrarian(state);
        const projected = this.project(state);
        this.changed(projected);
        return { state: projected };
      }
      const payload = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const receipt = await this.store.librarianReceipt(command.requestId, payload);
      if (receipt) {
        // A durable receipt cannot restore a session capability after restart.
        const { capability: _old, ...saved } = receipt;
        return this.capability?.runId === saved.state.run?.id &&
          this.capability?.sessionId === saved.state.run?.sessionId
          ? { ...saved, capability: this.capability!.token }
          : saved;
      }
      const state = await this.read();
      if (state.uiRevision !== command.expectedUiRevision)
        throw new ScopeError(409, "The Librarian view changed. Read it again before continuing.");
      let capability: string | undefined;
      if (command.action === "start") {
        if (!command.userRequest.trim())
          throw new ScopeError(400, "Include the user's explicit dreaming request.");
        if (state.run && state.run.status !== "completed")
          throw new ScopeError(
            409,
            "An interrupted dreaming run is retained. Ask the user whether to resume it.",
          );
        if (state.run) state.history.push(state.run);
        state.run = {
          id: randomUUID(),
          sessionId: command.sessionId,
          userRequest: command.userRequest,
          startedAt: this.now().toISOString(),
          status: "active",
          bundle: await this.inspection(),
          automaticPermissions: [...new Set(command.automaticPermissions ?? LibrarianRoutineWork)],
          proposals: [],
        };
        state.view = "decision";
        state.displayed = null;
        delete state.selectedChangeId;
        delete state.selectedPath;
        capability = randomBytes(32).toString("base64url");
        this.capability = { runId: state.run.id, sessionId: command.sessionId, token: capability };
      } else if (command.action === "resume") {
        if (!command.userRequest.trim())
          throw new ScopeError(400, "Include the user's explicit resume request.");
        if (!state.run || state.run.id !== command.runId || state.run.status === "completed")
          throw new ScopeError(409, "This run cannot be resumed.");
        await this.assertBundle(state.run);
        state.run.status = "active";
        state.run.sessionId = command.sessionId;
        if (command.automaticPermissions)
          state.run.automaticPermissions = [...new Set(command.automaticPermissions)];
        capability = randomBytes(32).toString("base64url");
        this.capability = { runId: state.run.id, sessionId: command.sessionId, token: capability };
      } else {
        const run = this.connection(command, state);
        await this.assertBundle(run);
        if (command.action === "select")
          // The agent asked for plain results; the person's filters would hide some of them.
          await this.navigate(
            state,
            command.view === "browse" ? { ...command, filters: {} } : command,
          );
        else if (command.action === "interrupt") {
          if (!command.userRequest.trim())
            throw new ScopeError(400, "Include the user's explicit request to pause dreaming.");
          run.status = "interrupted";
          this.capability = undefined;
        } else if (command.action === "finish") {
          if (!command.userRequest.trim())
            throw new ScopeError(400, "Include the user's explicit instruction to finish.");
          if (run.proposals.some((p) => p.change.status === "pending"))
            throw new ScopeError(409, "Resolve the remaining proposals before finishing.");
          run.status = "completed";
          run.completedAt = this.now().toISOString();
          run.finishRequest = command.userRequest;
          state.view = "overview";
          state.displayed = null;
          delete state.selectedChangeId;
          this.capability = undefined;
        } else {
          if (
            command.action !== "undo" &&
            command.disposition === "automatic" &&
            (!command.permission || !run.automaticPermissions.includes(command.permission))
          )
            throw new ScopeError(
              403,
              "Present this proposal for a human decision, or ask the user to permit this category when resuming.",
            );
          let change: MemoryChange;
          if (command.action === "present")
            change = cli(
              MemoryChange,
              await this.okf(["change", "read", "personal", command.changeId]),
            );
          else if (command.action === "undo")
            change = cli(
              MemoryChange,
              await this.okf(["change", "undo", "personal", command.changeId], {
                expectedRevisionHash: command.expectedRevisionHash,
                actor: { type: "agent", id: run.sessionId },
                reason: command.reason,
                requestId: command.requestId,
              }),
            );
          else
            change = cli(
              MemoryChange,
              await this.okf(["change", "propose", "personal"], {
                path: command.path,
                raw: command.raw,
                expectedHash: command.expectedHash,
                actor: { type: "agent", id: run.sessionId },
                reason: command.reason,
                sources: command.sources,
                requestId: command.requestId,
              }),
            );
          await this.add(state, {
            change,
            disposition: command.action === "undo" ? "human" : command.disposition,
            ...(command.action !== "undo" && command.permission
              ? { permission: command.permission }
              : {}),
            evidence: command.evidence,
          });
        }
      }
      if (
        ["start", "resume", "interrupt", "finish"].includes(command.action) &&
        state.run &&
        "userRequest" in command
      ) {
        state.run.activity = [
          ...(state.run.activity ?? []),
          {
            action: command.action as "start" | "resume" | "interrupt" | "finish",
            sessionId: command.sessionId,
            userRequest: command.userRequest,
            at: this.now().toISOString(),
          },
        ];
      }
      state.uiRevision++;
      const reply = { state: this.project(state), ...(capability ? { capability } : {}) };
      await this.store.saveLibrarian(state, {
        id: command.requestId,
        payload,
        reply: { state: reply.state },
      });
      this.changed(reply.state);
      return reply;
    });
  }
  human(input: unknown): Promise<LibrarianView> {
    const command = decode(LibrarianHumanCommand, input);
    return this.queue(async () => {
      const payload = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      const receipt = await this.store.librarianReceipt(command.requestId, payload);
      if (receipt) return receipt.state;
      const state = await this.read();
      if (state.uiRevision !== command.expectedUiRevision)
        throw new ScopeError(
          409,
          "The displayed content changed. Review it again before deciding.",
        );
      if (command.action === "navigate") await this.navigate(state, command);
      else if (command.action === "inspect") {
        if (command.comparison !== undefined) state.comparisonOpen = command.comparison;
        if (command.evidence !== undefined) state.evidenceOpen = command.evidence;
      } else if (command.action === "reminder") {
        if (command.enabled !== undefined) state.reminder.enabled = command.enabled;
        if (command.dismiss) {
          state.reminder.dismissedAt = this.now().toISOString();
          state.reminder.dueAt = new Date(this.now().getTime() + WEEK).toISOString();
        }
      } else {
        const run = state.run;
        if (!run || run.id !== command.runId || run.status === "completed")
          throw new ScopeError(409, "This dreaming run is no longer open.");
        if (state.view !== "decision" || state.selectedChangeId !== command.changeId)
          throw new ScopeError(409, "Open this proposal before deciding.");
        const proposal = run.proposals.find((p) => p.change.id === command.changeId);
        if (
          !proposal ||
          proposal.disposition !== "human" ||
          proposal.change.status !== "pending" ||
          proposal.change.revisionHash !== command.expectedRevisionHash ||
          JSON.stringify(proposal.change.sources) !== JSON.stringify(command.sources)
        )
          throw new ScopeError(
            409,
            "The displayed proposal or evidence changed. Read it again before deciding.",
          );
        if (JSON.stringify(state.displayed) !== JSON.stringify(proposal))
          throw new ScopeError(
            409,
            "The displayed proposal or evidence changed. Read it again before deciding.",
          );
        await this.assertBundle(run);
        const current = cli(
          MemoryChange,
          await this.okf(["change", "read", "personal", command.changeId]),
        );
        if (current.revisionHash !== command.expectedRevisionHash)
          throw new ScopeError(
            409,
            "This proposal changed outside Scope. Ask your agent to reconcile it.",
          );
        proposal.change = mutable(
          current.status !== "pending" &&
            current.review?.actor.type === "human" &&
            current.review.decision === command.decision
            ? current
            : cli(
                MemoryChange,
                await this.okf(["change", "review", "personal", command.changeId], {
                  expectedRevisionHash: command.expectedRevisionHash,
                  decision: command.decision,
                  actor: { type: "human", id: "scope-user" },
                  operator: true,
                  reason: command.reason,
                  sources: command.sources,
                }),
              ),
        );
        await this.navigate(state, { view: "decision" });
      }
      state.uiRevision++;
      const projected = this.project(state);
      await this.store.saveLibrarian(state, {
        id: command.requestId,
        payload,
        reply: { state: projected },
      });
      this.changed(projected);
      return projected;
    });
  }
}
