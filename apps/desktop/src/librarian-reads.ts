import { Schema } from "effect";
import { ScopeError } from "@irudd-scope/protocol";
import {
  LibrarianStage,
  MemoryChange,
  type LibrarianFilters,
  type LibrarianView,
} from "@irudd-scope/protocol/librarian";
import {
  MemoryConcept,
  MemoryGraph,
  MemoryList,
  MemorySearch,
  memoryFields,
  type MemoryActivity,
  type MemoryChangeSummary,
  type MemoryConnections,
  type MemoryFacets,
  type MemoryListPage,
  type MemoryStageName,
  type MemoryStages,
  type MemorySummary,
} from "./plugins/memory/contract.ts";

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Document = Mutable<
  Pick<
    LibrarianView,
    | "query"
    | "directory"
    | "offset"
    | "browse"
    | "activity"
    | "focusPath"
    | "run"
    | "history"
    | "bundle"
  >
>;
export function cli<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(schema)(input);
}
/** Keeps the irudd-okf error code so a caller can react to one specific refusal. */
export class OkfFailure extends ScopeError {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(409, message);
  }
}
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
type ChangeStatus = "pending" | "accepted" | "rejected" | "superseded";
/** Bounds how much recorded history one path scan reads; the UI reports when it stops early. */
const SCAN_LIMIT = 1000;
const SEARCH_LIMIT = 300;
const GRAPH_LIMIT = 40;
const STAGE_NAMES = LibrarianStage.literals;
const stageOf = (concept: MemorySummary): MemoryStageName => {
  const stage = memoryFields(concept.memory).stage;
  return STAGE_NAMES.find((name) => name === stage) ?? "none";
};

function matches(concept: MemorySummary, filters: LibrarianFilters) {
  const memory = memoryFields(concept.memory);
  return (
    (!filters.tag || concept.tags.includes(filters.tag)) &&
    (!filters.stage || (memory.stage ?? "none") === filters.stage) &&
    (!filters.kind || memory.kind === filters.kind) &&
    (!filters.applicability || memory.applicability?.type === filters.applicability)
  );
}
export const filtered = (filters: LibrarianFilters | undefined) =>
  !!filters && Object.values(filters).some((value) => value !== undefined);
function counted(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
export function facets(concepts: readonly MemorySummary[]): MemoryFacets {
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
/** irudd-okf reports a removed memory as NOT_ACCEPTED from read and NOT_FOUND from graph. */
export const missing = (error: unknown) =>
  error instanceof OkfFailure && (error.code === "NOT_FOUND" || error.code === "NOT_ACCEPTED");
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
    ...(change.action !== "delete" && (before ?? "none") !== (after ?? "none")
      ? { stageChange: { from: before ?? "none", to: after ?? "none" } }
      : {}),
  };
}

/** Read-only projections of the personal library for Librarian views. File semantics stay in irudd-okf. */
export class LibrarianReads {
  constructor(private okf: (args: string[]) => Promise<unknown>) {}
  async list() {
    return cli(MemoryList, await this.okf(["list", "--scope", "personal", "--all-applicability"]))
      .concepts;
  }
  async facets(): Promise<MemoryFacets> {
    try {
      return facets(await this.list());
    } catch {
      return {
        ...facets([]),
        unavailable: "Filters are unavailable because the library list could not be read.",
      };
    }
  }
  async search(query: string, offset: number) {
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
  async page(state: Document, concepts?: readonly MemorySummary[]) {
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
  async changes(offset: number, limit: number, status?: ChangeStatus) {
    return cli(
      ChangeList,
      await this.okf([
        "change",
        "list",
        "personal",
        ...(status ? ["--status", status] : []),
        "--limit",
        String(limit),
        "--offset",
        String(offset),
      ]),
    );
  }
  /** One newest-first page of recorded changes, read in smaller parts if bytes exceed the cap. */
  async recent(offset: number, status?: ChangeStatus) {
    const total = (await this.changes(0, 1, status)).total;
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - 20);
    const items: MemoryChange[] = [];
    const seen = new Set<string>();
    let size = 20;
    for (let to = end; to > start;) {
      const from = Math.max(start, to - size);
      try {
        const page = await this.changes(from, to - from, status);
        // A change recorded between reads shifts the pages; ids keep each change once.
        for (const change of [...page.changes].reverse())
          if (!seen.has(change.id)) {
            seen.add(change.id);
            items.push(change);
          }
        to = from;
      } catch (error) {
        if (error instanceof OkfFailure && error.code === "OUTPUT_LIMIT" && size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw error;
      }
    }
    return { items, total };
  }
  /**
   * Reads recorded changes newest first until enough match. irudd-okf lists oldest first, so pages
   * are taken from the end; a change recorded mid-scan can shift a page, which ids deduplicate.
   */
  async scan(
    match: (change: MemoryChange) => boolean,
    wanted: number,
    stop: (change: MemoryChange) => boolean = () => false,
  ) {
    const total = (await this.changes(0, 1)).total;
    const items: MemoryChange[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let size = 50;
    let stopped = false;
    while (!stopped && scanned < total && scanned < SCAN_LIMIT && items.length < wanted) {
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
        if (stopped || seen.has(change.id)) continue;
        seen.add(change.id);
        if (items.length < wanted && match(change)) items.push(change);
        stopped = stop(change);
      }
      scanned += limit;
    }
    return {
      items,
      scanned,
      total,
      partial: !stopped && items.length < wanted && scanned < total,
    };
  }
  async neighbourhood(
    focus: string,
    options: { depth: 1 | 2; sharedTags: boolean },
  ): Promise<MemoryConnections> {
    const graph = cli(
      MemoryGraph,
      await this.okf([
        "graph",
        "--scope",
        "personal",
        "--all-applicability",
        "--path",
        focus,
        "--depth",
        String(options.depth),
        "--limit",
        String(GRAPH_LIMIT),
      ]),
    );
    const path = (id: string) => id.replace(/^personal:/, "");
    const edges = graph.edges
      .filter((edge) => !edge.external)
      .map((edge) => ({
        from: path(edge.from),
        to: path(edge.to),
        label: edge.label ?? "",
        broken: !!edge.broken,
      }));
    // Rings follow explicit links in either direction; irudd-okf reports no other relation.
    const distance = new Map([[focus, 0]]);
    for (let step = 1; step <= options.depth; step++)
      for (const edge of edges)
        for (const [a, b] of [
          [edge.from, edge.to],
          [edge.to, edge.from],
        ])
          if (distance.get(a) === step - 1 && !distance.has(b) && !edge.broken)
            distance.set(b, step);
    const center = graph.nodes.find((node) => node.path === focus);
    return {
      focus,
      nodes: graph.nodes.map((node) => ({
        ...node,
        distance: distance.get(node.path) ?? options.depth,
      })),
      edges,
      sharedTags:
        options.sharedTags && center
          ? graph.nodes.flatMap((node) => {
              const tags = node.tags.filter(
                (tag) => node.path !== focus && center.tags.includes(tag),
              );
              return tags.length ? [{ to: node.path, tags }] : [];
            })
          : [],
      truncated: graph.truncated,
      depth: options.depth,
      limit: GRAPH_LIMIT,
    };
  }
  async medallion(
    options: { stage?: MemoryStageName; offset: number },
    focus: string | undefined,
    history: boolean,
  ): Promise<MemoryStages> {
    const concepts = [...(await this.list())].sort(byTitle);
    const grouped = Object.fromEntries(
      STAGE_NAMES.map((stage) => [stage, concepts.filter((concept) => stageOf(concept) === stage)]),
    ) as Record<MemoryStageName, MemorySummary[]>;
    const counts = Object.fromEntries(
      STAGE_NAMES.map((stage) => [stage, grouped[stage].length]),
    ) as Record<MemoryStageName, number>;
    const summary = focus ? concepts.find((concept) => concept.path === focus) : undefined;
    // Scanning recorded changes can take many reads, so it runs only when a memory is chosen here.
    const transitions =
      summary && history
        ? await this.scan(
            (change) => change.path === focus && !!changeSummary(change).stageChange,
            20,
            (change) => change.path === focus && change.action === "create",
          )
        : undefined;
    return {
      counts,
      ...(options.stage
        ? {
            page: {
              stage: options.stage,
              items: grouped[options.stage].slice(options.offset, options.offset + 20),
              offset: options.offset,
              total: counts[options.stage],
            },
          }
        : {
            columns: Object.fromEntries(
              STAGE_NAMES.map((stage) => [stage, grouped[stage].slice(0, 10)]),
            ) as Record<MemoryStageName, MemorySummary[]>,
          }),
      ...(summary
        ? {
            selected: {
              summary,
              ...(transitions
                ? {
                    transitions: transitions.items.map(changeSummary),
                    scanned: transitions.scanned,
                    partial: transitions.partial,
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  async activity(state: Document): Promise<MemoryActivity> {
    const options = state.activity!;
    const focus = state.focusPath;
    let listing: Pick<MemoryActivity, "total" | "page" | "scanned" | "partial" | "more">;
    if (options.onlySelected && focus) {
      // One extra match shows whether an older page exists; history ends at the file's creation.
      // A page kept from another memory may lie past this memory's history; start it again.
      const found = await this.scan(
        (change) => change.path === focus && (!options.status || change.status === options.status),
        options.offset + 21,
        (change) => change.path === focus && change.action === "create",
      );
      if (!found.items.slice(options.offset).length && options.offset > 0) {
        options.offset = 0;
        return this.activity(state);
      }
      listing = {
        total: Math.min(found.items.length, options.offset + 20),
        page: found.items.slice(options.offset, options.offset + 20).map(changeSummary),
        scanned: found.scanned,
        partial: found.partial,
        more: found.items.length > options.offset + 20,
      };
    } else {
      const found = await this.recent(options.offset, options.status);
      listing = {
        total: found.total,
        page: found.items.map(changeSummary),
        more: options.offset + 20 < found.total,
      };
    }
    let selected: MemoryActivity["selected"];
    let missingChange = false;
    if (options.changeId) {
      let change: MemoryChange | undefined;
      try {
        change = cli(
          MemoryChange,
          await this.okf(["change", "read", "personal", options.changeId]),
        );
      } catch (error) {
        // A change from another library, or one that no longer exists, must not lock Activity.
        if (!(error instanceof OkfFailure && error.code === "CHANGE_NOT_FOUND")) throw error;
        delete options.changeId;
        delete options.sourceHash;
        missingChange = true;
      }
      if (change) {
        const runs = [state.run, ...state.history].filter((run) => !!run);
        const run = runs.find((run) => run.proposals.some((p) => p.change.id === change.id));
        const proposal = run?.proposals.find((p) => p.change.id === change.id);
        selected = {
          change,
          ...(run && proposal
            ? {
                run: {
                  id: run.id,
                  startedAt: run.startedAt,
                  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
                  userRequest: run.userRequest,
                  disposition: proposal.disposition,
                  ...(proposal.permission ? { permission: proposal.permission } : {}),
                  evidence: proposal.evidence,
                  decidable:
                    run === state.run &&
                    run.status !== "completed" &&
                    proposal.disposition === "human" &&
                    proposal.change.status === "pending" &&
                    change.status === "pending",
                },
              }
            : {}),
        };
      }
    }
    let revision: MemoryActivity["revision"];
    const source = selected?.change.sources.find((entry) => entry.hash === options.sourceHash);
    if (source) revision = await this.revision(source, state.bundle?.id);
    return {
      ...listing,
      offset: options.offset,
      ...(selected ? { selected } : {}),
      ...(missingChange ? { missingChange } : {}),
      ...(revision ? { revision } : {}),
    };
  }
  /** Finds the bytes a change cited: the current file when it still matches, else recorded history. */
  async revision(
    source: { path: string; hash: string; bundle?: string },
    bundleId: string | undefined,
  ): Promise<NonNullable<MemoryActivity["revision"]>> {
    const base = { path: source.path, hash: source.hash };
    // irudd-okf records a source's library by bundle id; the name is accepted too.
    if (source.bundle && source.bundle !== "personal" && source.bundle !== bundleId)
      return { ...base, raw: null, current: false, otherBundle: true };
    try {
      const concept = await this.okf(["read", "personal", source.path, "--all-applicability"])
        .then((value) => cli(MemoryConcept, value))
        .catch(() => undefined);
      if (concept?.hash === source.hash) return { ...base, raw: concept.raw, current: true };
      const recorded = await this.scan(
        (change) => change.after?.hash === source.hash || change.before?.hash === source.hash,
        1,
      );
      const match = recorded.items[0];
      return {
        ...base,
        raw: match
          ? match.after?.hash === source.hash
            ? match.after.raw
            : match.before!.raw
          : null,
        current: false,
        scanned: recorded.scanned,
        partial: recorded.partial,
      };
    } catch {
      return { ...base, raw: null, current: false, unreadable: true };
    }
  }
}
