import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { LibrarianFilters, LibrarianView } from "@irudd-scope/protocol/librarian";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import {
  memoryFields,
  type MemoryConcept,
  type MemoryFacets,
  type MemoryListPage,
  type MemorySearch,
} from "./contract.ts";
import { applicability, applicabilityType, memoryKind, memoryStage } from "./format.ts";
import { Reader } from "./reader.tsx";
import type { Navigation } from "./navigation.ts";

type Folder = {
  entries: { path: string; kind: "directory" | "memory"; title?: string }[];
  truncated: boolean;
};
type Page = Folder | MemorySearch | MemoryListPage;
const STAGES = ["bronze", "silver", "gold", "none"] as const;

function Filters({
  filters,
  facets,
  disabled,
  onChange,
}: {
  filters: LibrarianFilters;
  facets: MemoryFacets | undefined;
  disabled: boolean;
  onChange: (filters: LibrarianFilters) => void;
}) {
  const unavailable = !facets || !!facets.unavailable;
  const set = (key: keyof LibrarianFilters, value: string) => {
    const next: Record<string, string> = { ...filters };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next as LibrarianFilters);
  };
  const tags = facets?.tags ?? [];
  const select = (
    label: string,
    key: keyof LibrarianFilters,
    options: { value: string; label: string }[],
  ) => (
    <label className="librarian-filter">
      <span>{label}</span>
      <NativeSelect
        aria-label={label}
        size="sm"
        value={filters[key] ?? ""}
        disabled={disabled || unavailable}
        onChange={(event) => set(key, event.target.value)}
      >
        <NativeSelectOption value="">All</NativeSelectOption>
        {/* Keep the active value selectable even when the current library no longer has it. */}
        {filters[key] && !options.some((option) => option.value === filters[key]) && (
          <NativeSelectOption value={filters[key]}>{filters[key]}</NativeSelectOption>
        )}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
  const count = (values: readonly { value: string; count: number }[] | undefined, value: string) =>
    values?.find((entry) => entry.value === value)?.count ?? 0;
  return (
    <div className="librarian-filters">
      {select(
        "Stage",
        "stage",
        STAGES.map((stage) => ({
          value: stage,
          label: `${memoryStage(stage)} (${count(facets?.stages, stage)})`,
        })),
      )}
      {select(
        "Kind",
        "kind",
        (facets?.kinds ?? []).map((kind) => ({
          value: kind.value,
          label: `${memoryKind(kind.value)} (${kind.count})`,
        })),
      )}
      {select(
        "Applies to",
        "applicability",
        (["global", "repository", "machine"] as const).map((type) => ({
          value: type,
          label: `${applicabilityType(type)} (${count(facets?.applicability, type)})`,
        })),
      )}
      {select(
        "Tag",
        "tag",
        tags.map((tag) => ({ value: tag.value, label: `#${tag.value} (${tag.count})` })),
      )}
      {Object.keys(filters).length > 0 && (
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
      {facets?.unavailable && <p className="librarian-note">{facets.unavailable}</p>}
      {!!facets && facets.tagTotal > tags.length && (
        <p className="librarian-note">
          Tag shows the {tags.length} most used of {facets.tagTotal} tags. Tag buttons on a memory
          filter by any tag.
        </p>
      )}
    </div>
  );
}

function Results({
  page,
  selected,
  busy,
  onOpen,
  onFolder,
}: {
  page: Page | null | undefined;
  selected?: string;
  busy: boolean;
  onOpen: (path: string) => void;
  onFolder: (path: string) => void;
}) {
  if (page === null)
    return <p>The result list could not be loaded. Search or clear filters to reload it.</p>;
  if (!page) return <p role="status">Loading memories…</p>;
  if ("entries" in page)
    return page.entries.length ? (
      <ul className="memory-link-list" aria-label="Memory results">
        {page.entries.map((entry) => (
          <li key={entry.path}>
            <button
              disabled={busy}
              aria-current={entry.path === selected ? "true" : undefined}
              onClick={() =>
                entry.kind === "directory" ? onFolder(entry.path) : onOpen(entry.path)
              }
            >
              {entry.title || entry.path.split("/").at(-1)}
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p>No memories found.</p>
    );
  return page.results.length ? (
    <ul className="memory-link-list" aria-label="Memory results">
      {page.results.map((hit) => {
        const fields = memoryFields(hit.memory);
        return (
          <li key={hit.path}>
            <button
              disabled={busy}
              aria-current={hit.path === selected ? "true" : undefined}
              onClick={() => onOpen(hit.path)}
            >
              {hit.title}
            </button>
            <small>
              {memoryStage(fields.stage)} · {memoryKind(fields.kind)} ·{" "}
              {applicability(fields.applicability)}
              {hit.tags.length ? ` · ${hit.tags.map((tag) => `#${tag}`).join(" ")}` : ""}
            </small>
            {(hit.excerpt || hit.description) && <p>{hit.excerpt || hit.description}</p>}
          </li>
        );
      })}
    </ul>
  ) : (
    <p>No memories match. Try another search or clear the filters.</p>
  );
}

function summary(page: Page | null | undefined) {
  if (!page || "entries" in page) return "";
  if ("filtered" in page) {
    const shown = page.results.length
      ? `${page.offset + 1}–${page.offset + page.results.length} of ${page.total}`
      : `0 of ${page.total}`;
    return page.searchLimited
      ? `${shown} matches in the first ${page.searchLimited.scanned} of ${page.searchLimited.total} search results`
      : `${shown} matching memories`;
  }
  return page.results.length
    ? `${page.offset + 1}–${page.offset + page.results.length} of ${page.total} results`
    : "";
}

export function BrowseView({
  state,
  busy,
  navigate,
  onError,
}: {
  state: LibrarianView;
  busy: boolean;
  navigate: (selection: Navigation) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(state.query);
  useEffect(() => setQuery(state.query), [state.query]);
  const reading = state.view === "memory" && state.displayed !== null;
  const page = (reading ? state.results : state.displayed) as Page | null | undefined;
  const concept = reading ? (state.displayed as MemoryConcept) : undefined;
  const filters = state.browse?.filters ?? {};
  const trail = state.browse?.trail ?? [];
  const offset = page && !("entries" in page) ? page.offset : (state.browse?.offset ?? 0);
  const step = page && !("entries" in page) ? 30 : 20;
  const list = (selection: Partial<Navigation>) =>
    navigate({
      view: "browse",
      query: state.query,
      directory: state.directory,
      offset: 0,
      ...selection,
    });
  const turn = (to: number) =>
    reading && concept
      ? navigate({ view: "memory", path: concept.path, trail: [...trail], offset: to })
      : list({ offset: to });
  const open = (path: string) => navigate({ view: "memory", path });
  return (
    <div className={reading ? "librarian-browse reading" : "librarian-browse"}>
      <div className="librarian-toolbar">
        <form
          className="memory-search"
          onSubmit={(event) => {
            event.preventDefault();
            list({ query, directory: "" });
          }}
        >
          <Input
            aria-label="Search memory"
            placeholder="Search memory…"
            value={query}
            maxLength={512}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            aria-label="Search memory"
            disabled={busy}
          >
            <Search />
          </Button>
        </form>
        <Filters
          filters={filters}
          facets={state.facets as MemoryFacets | undefined}
          disabled={busy}
          onChange={(next) =>
            // While reading, the filtered results update beside the memory instead of replacing it.
            reading && concept
              ? navigate({
                  view: "memory",
                  path: concept.path,
                  trail: [...trail],
                  filters: next,
                  offset: 0,
                })
              : list({ filters: next, directory: "" })
          }
        />
      </div>
      <div className="librarian-split">
        <section className="librarian-results" aria-label="Results">
          <div className="memory-note-actions">
            {(state.query || (state.directory && !Object.keys(filters).length)) && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  list(
                    state.query
                      ? { query: "", directory: "" }
                      : { directory: state.directory.split("/").slice(0, -1).join("/") },
                  )
                }
              >
                {state.query ? "Clear search" : "Up one folder"}
              </Button>
            )}
            {!state.query && state.directory && !Object.keys(filters).length && (
              <small>{state.directory}/</small>
            )}
          </div>
          {summary(page) && <p className="librarian-note">{summary(page)}</p>}
          <Results
            page={page}
            selected={concept?.path}
            busy={busy}
            onOpen={open}
            onFolder={(directory) => list({ directory, query: "" })}
          />
          {page && (
            <div className="memory-note-actions">
              {offset > 0 && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => turn(Math.max(0, offset - step))}
                >
                  Previous
                </Button>
              )}
              {page.truncated && (
                <Button variant="ghost" disabled={busy} onClick={() => turn(offset + step)}>
                  Next
                </Button>
              )}
            </div>
          )}
        </section>
        {concept ? (
          <Reader
            concept={concept}
            trail={trail}
            section={state.browse?.section ?? "connections"}
            returning={false}
            onOpen={(path) =>
              navigate({ view: "memory", path, trail: [...trail, concept.path].slice(-20) })
            }
            onBack={() =>
              navigate({ view: "memory", path: trail.at(-1)!, trail: trail.slice(0, -1) })
            }
            onResults={() => list({ offset: state.browse?.offset ?? 0 })}
            onTag={(tag) => list({ filters: { ...filters, tag }, query: "", directory: "" })}
            onSection={(section) =>
              navigate({ view: "memory", path: concept.path, trail: [...trail], section })
            }
            onError={onError}
          />
        ) : (
          <section className="librarian-reader librarian-wide-only" aria-label="Memory">
            <p className="librarian-note">Choose a memory to read it here.</p>
          </section>
        )}
      </div>
    </div>
  );
}
