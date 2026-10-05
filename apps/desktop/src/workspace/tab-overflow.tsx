import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import { ArrowLeft, ChevronDown, RotateCcw, Search, Trash2, X } from "lucide-react";
import type { Artifact } from "@irudd-scope/protocol";
import { Button } from "../renderer/components/ui/button.tsx";
import { Input } from "../renderer/components/ui/input.tsx";
import { tabArtifactId } from "../plugins/registry.renderer.ts";
import { isBuiltinTab } from "../plugins/registry.ts";
import type { Tab } from "./contract.ts";
import { TRASH_RETENTION_MS, type RetainedTab } from "./retention.ts";
import { TabPermanence } from "./tab-permanence.tsx";
import { EmptyTrash } from "./empty-trash.tsx";
import type { TabDrag } from "./use-tab-drag.ts";

export function TabOverflow({
  tabs,
  retainedTabs,
  hiddenIds,
  artifacts,
  unread,
  tabButtons,
  onSelect,
  onPermanent,
  onRestore,
  drag,
  open,
  onOpenChange,
  restoreFocus,
}: {
  tabs: readonly Tab[];
  retainedTabs: readonly RetainedTab[];
  hiddenIds: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, Artifact>;
  unread: ReadonlySet<string>;
  tabButtons: RefObject<Map<string, HTMLButtonElement>>;
  onSelect: (id: string) => void;
  onPermanent: (id: string, permanent: boolean) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  drag: TabDrag;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: boolean;
}) {
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  const [section, setSection] = useState<"active" | "trash">("active");
  const [filter, setFilter] = useState<"all" | "permanent" | "temporary">("all");
  const [pending, setPending] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const chosen = useRef<string | null>(null);
  const needle = query.trim().toLowerCase();
  const retention = new Map(retainedTabs.map((entry) => [entry.tab.id, entry]));
  const trash = retainedTabs
    .filter((entry) => entry.trashedAt !== null)
    .toSorted((a, b) => b.trashedAt! - a.trashedAt! || a.tab.id.localeCompare(b.tab.id));
  const ordered = section === "trash" ? trash.map((entry) => entry.tab) : tabs;
  const entries = ordered.flatMap((tab) => {
    const entry = retention.get(tab.id);
    const artifactId = tabArtifactId(tab);
    const artifact = artifacts.get(artifactId ?? "");
    const title = artifact?.title ?? tab.title;
    const kind = artifact?.kind ?? tab.type;
    const name = artifact?.name;
    const permanent = isBuiltinTab(tab) || (entry?.permanent ?? false);
    if (section === "active" && filter !== "all" && permanent !== (filter === "permanent"))
      return [];
    if (needle && !`${title} ${kind} ${name ?? ""}`.toLowerCase().includes(needle)) return [];
    return [
      {
        tab,
        title,
        kind,
        name,
        permanent,
        trashedAt: entry?.trashedAt ?? null,
      },
    ];
  });
  const hasUnread = tabs.some(
    (tab) => hiddenIds.has(tab.id) && unread.has(tabArtifactId(tab) ?? ""),
  );
  const drawerLabel = `Tabs and Trashcan, ${tabs.length} active ${tabs.length === 1 ? "tab" : "tabs"}`;
  const trashEntries = trash.map((entry) => ({ id: entry.tab.id, trashedAt: entry.trashedAt! }));

  function navigate(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    const buttons = Array.from(
      results.current?.querySelectorAll<HTMLButtonElement>("[data-tab-result]") ?? [],
    );
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 && document.activeElement !== input.current) return;
    event.preventDefault();
    if (event.key === "Enter") buttons[Math.max(0, index)]?.click();
    else {
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }
  async function restore(id: string) {
    setPending(id);
    try {
      await onRestore(id);
      chosen.current = id;
      onOpenChange(false);
    } finally {
      setPending(null);
    }
  }

  function changeOpen(value: boolean) {
    onOpenChange(value);
    if (value) {
      setQuery("");
      setSection("active");
      chosen.current = null;
    }
  }

  return (
    <Popover.Root open={open} modal="trap-focus" onOpenChange={changeOpen}>
      <Popover.Trigger
        render={<Button variant="ghost" className="tab-overflow-trigger" />}
        aria-label={drawerLabel}
        title={drawerLabel}
        {...drag.drawerTrigger(() => changeOpen(true))}
      >
        <ChevronDown aria-hidden="true" />
        <span>{tabs.length}</span>
        {hasUnread && <span className="unread-dot" role="img" aria-label="Updated artifact" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
          className="tab-overflow-positioner"
        >
          <Popover.Popup
            className="tab-overflow-popup"
            initialFocus={drag.draggingId ? false : input}
            finalFocus={() =>
              restoreFocus &&
              (chosen.current ? (tabButtons.current.get(chosen.current) ?? false) : true)
            }
            onKeyDown={navigate}
          >
            {section === "active" ? (
              <Popover.Title className="sr-only">Active tabs</Popover.Title>
            ) : (
              <div className="tab-overflow-heading">
                <Popover.Title>Trashcan</Popover.Title>
                <span>
                  <Button variant="ghost" size="sm" onClick={() => setSection("active")}>
                    <ArrowLeft /> Active
                  </Button>
                </span>
                <Popover.Close
                  render={<Button variant="ghost" size="icon-xs" aria-label="Close tab picker" />}
                >
                  <X />
                </Popover.Close>
              </div>
            )}
            <div className="workspace-search-field">
              <Search aria-hidden="true" />
              <Input
                ref={input}
                aria-label="Search tabs"
                placeholder="Search titles, names, and kinds…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear tab search"
                  onClick={() => {
                    setQuery("");
                    input.current?.focus();
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
            {section === "active" ? (
              <div className="tab-retention-filters" aria-label="Filter active tabs">
                {(["all", "permanent", "temporary"] as const).map((value) => (
                  <Button
                    key={value}
                    variant="ghost"
                    size="sm"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all" ? "All" : value === "permanent" ? "Permanent" : "Temporary"}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="retention-note">
                Tabs stay here for 7 days. Restore one to use it again.
              </p>
            )}
            <div className="tab-overflow-results" ref={results}>
              {entries.map(({ tab, title, kind, name, permanent, trashedAt }) =>
                trashedAt !== null ? (
                  <button
                    key={tab.id}
                    className="tab-overflow-result"
                    data-tab-result
                    title={title}
                    disabled={pending === tab.id}
                    onClick={() => void restore(tab.id)}
                  >
                    <RotateCcw aria-hidden="true" />
                    <span className="tab-drawer-title">
                      <span>{title}</span>
                      <small>
                        {name ? `${name} · ` : ""}
                        {kind}
                      </small>
                    </span>
                    <small
                      title={`Deletes ${new Date(trashedAt + TRASH_RETENTION_MS).toLocaleString()}`}
                    >
                      {pending === tab.id
                        ? "Restoring…"
                        : `Restore · ${Math.max(1, Math.ceil((trashedAt + TRASH_RETENTION_MS - now) / 86_400_000))}d left`}
                    </small>
                  </button>
                ) : (
                  <div className="tab-drawer-row" key={tab.id} {...drag.row(tab.id, "vertical")}>
                    <div className="tab-drawer-label">
                      <button
                        className="tab-drawer-select"
                        data-tab-result
                        aria-label={`${title} ${name ? `${name} · ` : ""}${kind}`}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Delete"
                        aria-description={
                          isBuiltinTab(tab)
                            ? "Drag or Alt and arrow keys to reorder. Delete closes this built-in tab."
                            : "Drag to reorder or drop onto Trashcan. Alt and arrow keys reorder; Delete moves to Trashcan."
                        }
                        title={title}
                        onKeyDown={(event) =>
                          drag.keyboard(
                            event,
                            tab.id,
                            entries.map((entry) => entry.tab.id),
                            "vertical",
                          )
                        }
                        onClick={() => {
                          chosen.current = tab.id;
                          onSelect(tab.id);
                          onOpenChange(false);
                        }}
                      >
                        {title}
                      </button>
                      <TabPermanence
                        tab={tab}
                        title={title}
                        permanent={permanent}
                        onPermanent={onPermanent}
                      />
                    </div>
                    <small>
                      {name ? `${name} · ` : ""}
                      {kind}
                    </small>
                  </div>
                ),
              )}
              {!entries.length && (
                <p className="search-empty" role="status">
                  {needle
                    ? `No tabs match "${query}".`
                    : section === "trash"
                      ? "Trashcan is empty."
                      : filter === "all"
                        ? "No active tabs."
                        : `No ${filter} tabs.`}
                </p>
              )}
            </div>
            {section === "active" ? (
              <div className="tab-drawer-footer">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSection("trash")}
                  {...drag.trash}
                >
                  <Trash2 /> Trashcan
                </Button>
              </div>
            ) : (
              open && <EmptyTrash key={JSON.stringify(trashEntries)} entries={trashEntries} />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
