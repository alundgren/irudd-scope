import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link } from "lucide-react";
import type { FolderEntry, FolderListing } from "@irudd-scope/protocol/folder";
import type { FolderNameMatch } from "./contract.ts";

const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export type FolderRow = {
  entry: FolderEntry;
  /** A row standing for an expanded folder whose contents are not loaded yet. */
  placeholder?: "loading" | "retrying" | "failed";
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
  failed: ReadonlyMap<string, "retrying" | "failed"> = new Map(),
): FolderRow[] {
  const rows: FolderRow[] = [];
  const visit = (directory: string, depth: number) => {
    const listing = listings.get(directory);
    if (!listing) {
      if (directory)
        rows.push({
          entry: { name: "", path: `${directory}/`, kind: "other", ignored: false },
          placeholder: failed.get(directory) ?? "loading",
          depth,
          expanded: false,
          deleted: false,
          setSize: 1,
          position: 1,
        });
      return;
    }
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
  if (row.placeholder) return null;
  if (row.entry.kind === "symlink") return <Link aria-hidden="true" />;
  if (row.entry.kind === "directory")
    return row.expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />;
  return <File aria-hidden="true" />;
}

function rowLabel(row: FolderRow, unsaved: boolean) {
  if (row.placeholder === "loading") return "Loading…";
  if (row.placeholder === "retrying") return "Could not read this folder. Retrying…";
  if (row.placeholder === "failed") return "Could not read this folder. Select to retry.";
  if (row.deleted) return `${row.entry.name}, deleted`;
  if (unsaved) return `${row.entry.name}, unsaved changes`;
  if (row.entry.kind === "symlink")
    return `${row.entry.name}, ${row.entry.link === "outside" ? "link outside this folder" : "link"}`;
  return row.entry.ignored ? `${row.entry.name}, ignored` : row.entry.name;
}

/** The folder a drop on this row copies into: the folder itself, or a file's folder. */
function dropFolder(row: FolderRow | undefined) {
  if (!row) return "";
  if (row.placeholder) return row.entry.path.slice(0, -1);
  return row.entry.kind === "directory" ? row.entry.path : parent(row.entry.path);
}
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export function FolderTree({
  tabId,
  rows,
  selected,
  unsaved,
  revealCount,
  onToggle,
  onSelect,
  onRetry,
  onDropFiles,
}: {
  tabId: string;
  rows: readonly FolderRow[];
  selected: string | null;
  /** Files with unsaved edits. */
  unsaved: ReadonlySet<string>;
  /** Counts requests to show the selected file, which can repeat for the same file. */
  revealCount: number;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
  onRetry: (directory: string) => void;
  /** Files dropped from the computer onto a folder, or onto empty space for the top folder. */
  onDropFiles: (folder: string, files: File[]) => void;
}) {
  const [dropTarget, setDropTarget] = useState<string | undefined>();
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
  // Scroll to a file selected outside the tree, such as by an agent's `folder select`,
  // once its row is loaded and the tree is visible. A repeated request scrolls again.
  const unrevealed = useRef(selected);
  useEffect(() => {
    unrevealed.current = selected;
  }, [selected, revealCount]);
  useEffect(() => {
    const index = rows.findIndex((row) => row.entry.path === unrevealed.current);
    if (index < 0 || !container.current?.clientHeight) return;
    unrevealed.current = null;
    reveal(index);
  });
  function activate(row: FolderRow) {
    if (row.placeholder === "failed") onRetry(row.entry.path.slice(0, -1));
    if (row.placeholder) return;
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

  function rowAt(event: DragEvent) {
    const element = (event.target as Element).closest?.("[data-row-index]");
    return element ? rows[Number(element.getAttribute("data-row-index"))] : undefined;
  }
  function dragOver(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(dropFolder(rowAt(event)));
  }

  return (
    <div
      ref={container}
      className="folder-tree"
      role="tree"
      aria-label="Folder contents"
      data-drop-root={dropTarget === "" || undefined}
      onDragEnter={dragOver}
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (!container.current?.contains(event.relatedTarget as Node | null))
          setDropTarget(undefined);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropTarget(undefined);
        onDropFiles(dropFolder(rowAt(event)), [...event.dataTransfer.files]);
      }}
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
              aria-label={rowLabel(row, unsaved.has(entry.path))}
              title={
                entry.kind === "symlink" && entry.link === "outside"
                  ? "This link points outside the folder and cannot be opened."
                  : entry.path
              }
              className="folder-row"
              data-row-index={index}
              data-drop-target={
                (dropTarget && !row.placeholder && entry.path === dropTarget) || undefined
              }
              data-focused={index === focusIndex || undefined}
              data-ignored={entry.ignored || undefined}
              data-deleted={row.deleted || undefined}
              data-placeholder={row.placeholder}
              style={{
                transform: `translateY(${index * ROW_HEIGHT}px)`,
                paddingLeft: `calc(${row.depth - 1} * var(--folder-indent) + var(--scope-space-2))`,
              }}
              onClick={() => activate(row)}
              onContextMenu={(event) => {
                if (row.placeholder || row.deleted || entry.kind === "symlink") return;
                event.preventDefault();
                setFocused(entry.path);
                void window.scope.showFolderFileMenu({
                  tabId,
                  path: entry.path,
                  directory: entry.kind === "directory",
                });
              }}
            >
              <span className="folder-row-chevron" aria-hidden="true">
                {expandable && (row.expanded ? <ChevronDown /> : <ChevronRight />)}
              </span>
              <RowIcon row={row} />
              <span className="folder-row-name">
                {row.placeholder ? rowLabel(row, false) : entry.name}
              </span>
              {row.deleted && <small>Deleted</small>}
              {!row.deleted && unsaved.has(entry.path) && <small>Edited</small>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
