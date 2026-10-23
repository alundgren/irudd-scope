import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link } from "lucide-react";
import type { FolderEntry, FolderListing } from "@irudd-scope/protocol/folder";
import type { FolderNameMatch } from "./contract.ts";

const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export type FolderRow = {
  entry: FolderEntry;
  depth: number;
  expanded: boolean;
  /** The selected file was deleted; it stays shown until another file is selected. */
  deleted: boolean;
  setSize: number;
  position: number;
};

function parent(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Flattens the loaded directories into the rows the tree shows, in display order. */
export function folderRows(
  listings: ReadonlyMap<string, FolderListing>,
  expanded: ReadonlySet<string>,
  selected: string | null,
): FolderRow[] {
  const rows: FolderRow[] = [];
  const visit = (directory: string, depth: number) => {
    const listing = listings.get(directory);
    if (!listing) return;
    const entries: { entry: FolderEntry; deleted: boolean }[] = listing.entries.map((entry) => ({
      entry,
      deleted: false,
    }));
    if (
      selected &&
      parent(selected) === directory &&
      !listing.entries.some((entry) => entry.path === selected)
    )
      entries.push({
        entry: {
          name: selected.slice(directory ? directory.length + 1 : 0),
          path: selected,
          kind: "file",
          ignored: false,
        },
        deleted: true,
      });
    entries.forEach(({ entry, deleted }, index) => {
      const open = entry.kind === "directory" && expanded.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded: open,
        deleted,
        setSize: entries.length,
        position: index + 1,
      });
      if (open) visit(entry.path, depth + 1);
    });
  };
  visit("", 1);
  return rows;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Rows for a filter: every matching file with its parent folders open. Folders the person
 * closes while filtering are in `collapsed`; the saved expanded folders are untouched.
 */
export function filteredRows(
  matches: readonly FolderNameMatch[],
  collapsed: ReadonlySet<string>,
): FolderRow[] {
  const children = new Map<string, { directories: Set<string>; files: FolderEntry[] }>();
  const directory = (path: string) => {
    let entry = children.get(path);
    if (!entry) children.set(path, (entry = { directories: new Set(), files: [] }));
    return entry;
  };
  for (const match of matches) {
    const above = parent(match.path);
    directory(above).files.push({
      name: match.path.slice(above ? above.length + 1 : 0),
      path: match.path,
      kind: "file",
      ignored: match.ignored,
    });
    for (let path = above; path; path = parent(path)) directory(parent(path)).directories.add(path);
  }
  const rows: FolderRow[] = [];
  const visit = (path: string, depth: number) => {
    const entry = children.get(path);
    if (!entry) return;
    const name = (child: string) => child.slice(path ? path.length + 1 : 0);
    const entries: FolderEntry[] = [
      ...[...entry.directories]
        .map((child): FolderEntry => ({
          name: name(child),
          path: child,
          kind: "directory",
          ignored: false,
        }))
        .sort((a, b) => collator.compare(a.name, b.name)),
      ...entry.files.sort((a, b) => collator.compare(a.name, b.name)),
    ];
    entries.forEach((child, index) => {
      const open = child.kind === "directory" && !collapsed.has(child.path);
      rows.push({
        entry: child,
        depth,
        expanded: open,
        deleted: false,
        setSize: entries.length,
        position: index + 1,
      });
      if (open) visit(child.path, depth + 1);
    });
  };
  visit("", 1);
  return rows;
}

function RowIcon({ row }: { row: FolderRow }) {
  if (row.entry.kind === "symlink") return <Link aria-hidden="true" />;
  if (row.entry.kind === "directory")
    return row.expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />;
  return <File aria-hidden="true" />;
}

function rowLabel(row: FolderRow) {
  if (row.deleted) return `${row.entry.name}, deleted`;
  if (row.entry.kind === "symlink")
    return `${row.entry.name}, ${row.entry.link === "outside" ? "link outside this folder" : "link"}`;
  return row.entry.ignored ? `${row.entry.name}, ignored` : row.entry.name;
}

export function FolderTree({
  tabId,
  rows,
  selected,
  onToggle,
  onSelect,
}: {
  tabId: string;
  rows: readonly FolderRow[];
  selected: string | null;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [focused, setFocused] = useState<string | null>(selected);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    measure();
    return () => resize.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.entry.path === focused),
  );
  const rowId = (path: string) => `folder-${tabId}-${encodeURIComponent(path)}`;

  function reveal(index: number) {
    const element = container.current;
    const row = rows[index];
    if (!element || !row) return;
    setFocused(row.entry.path);
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
  }
  function activate(row: FolderRow) {
    setFocused(row.entry.path);
    if (row.entry.kind === "directory") onToggle(row.entry.path, !row.expanded);
    else onSelect(row.entry.path);
  }
  function keyboard(event: KeyboardEvent) {
    const row = rows[focusIndex];
    if (!row) return;
    const moves: Record<string, () => void> = {
      ArrowDown: () => reveal(Math.min(rows.length - 1, focusIndex + 1)),
      ArrowUp: () => reveal(Math.max(0, focusIndex - 1)),
      Home: () => reveal(0),
      End: () => reveal(rows.length - 1),
      ArrowRight: () => {
        if (row.entry.kind === "directory" && !row.expanded) onToggle(row.entry.path, true);
        else if (row.expanded) reveal(focusIndex + 1);
      },
      ArrowLeft: () => {
        if (row.expanded) onToggle(row.entry.path, false);
        else
          reveal(
            Math.max(
              0,
              rows.findIndex((entry) => entry.entry.path === parent(row.entry.path)),
            ),
          );
      },
      Enter: () => activate(row),
      " ": () => activate(row),
    };
    const move = moves[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    move();
  }

  return (
    <div
      ref={container}
      className="folder-tree"
      role="tree"
      aria-label="Folder contents"
      tabIndex={0}
      aria-activedescendant={rows[focusIndex] ? rowId(rows[focusIndex]!.entry.path) : undefined}
      onKeyDown={keyboard}
      onScroll={(event) =>
        setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const { entry } = row;
          const expandable = entry.kind === "directory";
          return (
            <div
              key={entry.path}
              id={rowId(entry.path)}
              role="treeitem"
              aria-level={row.depth}
              aria-setsize={row.setSize}
              aria-posinset={row.position}
              aria-selected={entry.path === selected}
              aria-expanded={expandable ? row.expanded : undefined}
              aria-label={rowLabel(row)}
              title={
                entry.kind === "symlink" && entry.link === "outside"
                  ? "This link points outside the folder and cannot be opened."
                  : entry.path
              }
              className="folder-row"
              data-focused={index === focusIndex || undefined}
              data-ignored={entry.ignored || undefined}
              data-deleted={row.deleted || undefined}
              style={{
                transform: `translateY(${index * ROW_HEIGHT}px)`,
                paddingLeft: `calc(${row.depth - 1} * var(--folder-indent) + var(--scope-space-2))`,
              }}
              onClick={() => activate(row)}
            >
              <span className="folder-row-chevron" aria-hidden="true">
                {expandable && (row.expanded ? <ChevronDown /> : <ChevronRight />)}
              </span>
              <RowIcon row={row} />
              <span className="folder-row-name">{entry.name}</span>
              {row.deleted && <small>Deleted</small>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
