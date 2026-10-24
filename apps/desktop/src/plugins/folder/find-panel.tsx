import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_FOLDER_NAME_MATCHES } from "@irudd-scope/protocol/folder";
import { Button } from "../../renderer/components/ui/button.tsx";
import type {
  FolderNameMatch,
  FolderPathsState,
  FolderSearchMatch,
  FolderViewEvent,
} from "./contract.ts";

const FILTER_DELAY_MS = 60;
const SEARCH_DELAY_MS = 250;

export type FolderFilter = {
  state: FolderPathsState;
  /** Matches for `text`; undefined until the first answer for a non-empty filter. */
  matches: FolderNameMatch[] | undefined;
  text: string;
  truncated: boolean;
};

/**
 * Starts the tab's in-memory path list when the folder is readable and asks it for
 * matches while the filter has text. The list lives in desktop main and is never stored.
 */
export function useFolderFilter(tabId: string, text: string, showIgnored: boolean, ready: boolean) {
  const [filter, setFilter] = useState<FolderFilter>({
    state: "scanning",
    matches: undefined,
    text: "",
    truncated: false,
  });
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ask = useCallback(
    (delay: number) => {
      const request = ++latest.current;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void window.scope
          .folderFilter({ tabId, text, showIgnored })
          .then((result) => {
            if (request !== latest.current || result.status !== "ok") return;
            setFilter({
              state: result.state,
              matches: text ? result.matches : undefined,
              text,
              truncated: result.truncated,
            });
          })
          .catch(() => {});
      }, delay);
    },
    [tabId, text, showIgnored],
  );
  useEffect(() => {
    if (ready) ask(text ? FILTER_DELAY_MS : 0);
    return () => clearTimeout(timer.current);
  }, [ready, ask, text]);
  useEffect(() => {
    if (!ready) return;
    return window.scope.onFolderEvent(({ tabId: id, event }: FolderViewEvent) => {
      if (id === tabId && event.type === "paths") ask(FILTER_DELAY_MS);
    });
  }, [ready, tabId, ask]);
  return filter;
}

type SearchState =
  | { status: "idle" }
  | { status: "running"; query: string }
  | {
      status: "done";
      query: string;
      matches: FolderSearchMatch[];
      truncated: boolean;
      cancelled: boolean;
    }
  | { status: "failed"; message: string };

function Highlighted({ text, query }: { text: string; query: string }) {
  const trimmed = text.trimStart();
  const at = trimmed.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{trimmed}</>;
  return (
    <>
      {trimmed.slice(0, at)}
      <mark>{trimmed.slice(at, at + query.length)}</mark>
      {trimmed.slice(at + query.length)}
    </>
  );
}

/** Content search, run on the folder's machine. Results stay in this view only. */
export function FolderSearch({
  tabId,
  showIgnored,
  selected,
  onOpen,
}: {
  tabId: string;
  showIgnored: boolean;
  selected: { path: string; line: number } | undefined;
  onOpen: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const latest = useRef(0);
  useEffect(() => {
    const request = ++latest.current;
    if (!query) {
      setSearch({ status: "idle" });
      void window.scope.cancelFolderSearch(tabId).catch(() => {});
      return;
    }
    const timer = setTimeout(() => {
      setSearch({ status: "running", query });
      window.scope.folderSearch({ tabId, query, showIgnored }).then(
        (result) => {
          if (request !== latest.current) return;
          setSearch(
            result.status === "ok"
              ? {
                  status: "done",
                  query,
                  matches: result.matches,
                  truncated: result.truncated,
                  cancelled: result.cancelled,
                }
              : { status: "failed", message: result.message },
          );
        },
        () => {
          if (request === latest.current)
            setSearch({ status: "failed", message: "The search failed." });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tabId, query, showIgnored]);
  useEffect(
    () => () => {
      void window.scope.cancelFolderSearch(tabId).catch(() => {});
    },
    [tabId],
  );

  const done = search.status === "done" ? search : undefined;
  return (
    <>
      <input
        className="folder-find-input"
        type="search"
        aria-label="Search file contents"
        placeholder="Search file contents"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("");
        }}
      />
      <div className="folder-find-status" role="status">
        {search.status === "running" && (
          <>
            <span>Searching…</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.scope.cancelFolderSearch(tabId)}
            >
              Cancel
            </Button>
          </>
        )}
        {search.status === "failed" && <span>{search.message}</span>}
        {done &&
          (done.cancelled
            ? `Search cancelled after ${done.matches.length.toLocaleString()} matches.`
            : done.truncated
              ? `Stopped at ${done.matches.length.toLocaleString()} matches.`
              : done.matches.length
                ? `${done.matches.length.toLocaleString()} ${done.matches.length === 1 ? "match" : "matches"}`
                : "No matches.")}
      </div>
      {done && done.matches.length > 0 && (
        <ol className="folder-search-results" aria-label="Search results">
          {done.matches.map((match) => (
            <li key={`${match.path}:${match.line}`}>
              <button
                type="button"
                aria-current={
                  selected?.path === match.path && selected.line === match.line ? true : undefined
                }
                onClick={() => onOpen(match.path, match.line)}
              >
                <span className="folder-search-place">
                  {match.path}:{match.line}
                </span>
                <span className="folder-search-text">
                  <Highlighted text={match.text} query={done.query} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** The filter's status line: scanning, machine-side matching, counts, and limits. */
/** `machine` reads inside a sentence, such as `this computer` or `devbox`. */
export function filterStatus(filter: FolderFilter, machine: string): string {
  const parts: string[] = [];
  if (filter.state === "machine")
    parts.push(
      `This folder has too many files to list, so Scope asks ${machine} for matching names.`,
    );
  else if (filter.state === "scanning") parts.push("Still scanning…");
  else if (filter.state === "failed") parts.push("Some folders could not be read.");
  const count = filter.matches?.length;
  if (count !== undefined)
    parts.push(
      filter.truncated
        ? `Showing the first ${MAX_FOLDER_NAME_MATCHES.toLocaleString()} files.`
        : count
          ? `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`
          : "No files match.",
    );
  return parts.join(" ");
}
