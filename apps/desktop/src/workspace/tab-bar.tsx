import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Bookmark, Search, X } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import { tabArtifactId } from "../plugins/registry.renderer.ts";
import type { Tab } from "./contract.ts";
import type { RetainedTab } from "./retention.ts";
import { TabOverflow } from "./tab-overflow.tsx";
import { useTabDrag, type ReorderTab } from "./use-tab-drag.ts";

export function TabBar({
  tabs,
  retainedTabs,
  onPermanent,
  onRestore,
  onVisible,
  selectedId,
  artifacts,
  unread,
  tabButtons,
  controlsButton,
  searchOpen,
  overflowOpen,
  onOverflowChange,
  restoreOverflowFocus,
  onSelect,
  onReorder,
  onClose,
  onTrash,
  onSearch,
}: {
  tabs: readonly Tab[];
  retainedTabs: readonly RetainedTab[];
  onPermanent: (id: string, permanent: boolean) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onVisible: (ids: string[]) => void;
  selectedId: string | null;
  artifacts: ReadonlyMap<string, Artifact>;
  unread: ReadonlySet<string>;
  tabButtons: RefObject<Map<string, HTMLButtonElement>>;
  controlsButton: RefObject<HTMLButtonElement | null>;
  searchOpen: boolean;
  overflowOpen: boolean;
  onOverflowChange: (open: boolean) => void;
  restoreOverflowFocus: boolean;
  onSelect: (id: string, keyboard?: boolean) => void;
  onReorder: ReorderTab;
  onClose: (id: string) => Promise<void>;
  onTrash: (id: string) => Promise<void>;
  onSearch: () => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const drag = useTabDrag(onReorder, onTrash);
  const [capacity, setCapacity] = useState(1);
  useLayoutEffect(() => {
    const element = navigation.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const gap = parseFloat(style.columnGap);
      const width =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) + gap;
      const tabWidth = parseFloat(style.getPropertyValue("--tab-min-width")) + gap;
      const pickerWidth = parseFloat(style.getPropertyValue("--tab-picker-width")) + gap;
      setCapacity(Math.floor((width - pickerWidth) / tabWidth));
    };
    const resize = new ResizeObserver(measure);
    measure();
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const count = Math.max(1, capacity);
  let visibleTabs = tabs.slice(-count);
  const selected = tabs.find((tab) => tab.id === selectedId);
  if (selected && !visibleTabs.includes(selected))
    visibleTabs = [selected, ...visibleTabs.slice(1)];
  const visibleIds = new Set(visibleTabs.map((tab) => tab.id));
  const hiddenIds = new Set(tabs.filter((tab) => !visibleIds.has(tab.id)).map((tab) => tab.id));
  const openArtifacts = new Set(tabs.map(tabArtifactId));
  const visibleKey = visibleTabs.map((tab) => tab.id).join();
  useEffect(() => {
    onVisible(visibleKey ? visibleKey.split(",") : []);
  }, [visibleKey, onVisible]);
  function navigateTabs(event: ReactKeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.findIndex((tab) => tab.id === selectedId);
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index + tabs.length - 1) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    onSelect(tabs[target].id, true);
  }
  return (
    <header className="workspace-bar">
      <nav className="tabs" aria-label="Open artifacts" ref={navigation}>
        <TabOverflow
          tabs={tabs}
          retainedTabs={retainedTabs}
          onPermanent={onPermanent}
          onRestore={onRestore}
          drag={drag}
          hiddenIds={hiddenIds}
          artifacts={artifacts}
          unread={unread}
          tabButtons={tabButtons}
          onSelect={(id) => onSelect(id, true)}
          open={overflowOpen}
          onOpenChange={onOverflowChange}
          restoreFocus={restoreOverflowFocus}
        />
        <div className="contents" role="tablist" aria-label="Artifacts" onKeyDown={navigateTabs}>
          {visibleTabs.map((tab) => {
            const { id } = tab;
            const artifactId = tabArtifactId(tab);
            const artifact = artifacts.get(artifactId ?? "");
            const title = artifact?.title ?? tab.title;
            const permanent = retainedTabs.find((entry) => entry.tab.id === id)?.permanent ?? false;
            const isSelected = id === selectedId;
            return (
              <div
                className={`artifact-tab${isSelected ? " selected" : ""}`}
                key={id}
                {...drag.row(id, "horizontal")}
              >
                <button
                  ref={(element) => {
                    if (element) tabButtons.current.set(id, element);
                    else tabButtons.current.delete(id);
                  }}
                  className="tab-title"
                  id={`tab-${id}`}
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={`pane-${id}`}
                  tabIndex={id === selectedId ? 0 : -1}
                  title={title}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
                  aria-description="Drag to reorder. Hold over Tabs and Trashcan to open the drawer and drop onto Trashcan. Alt and arrow keys reorder; Delete moves to Trashcan."
                  onKeyDown={(event) =>
                    drag.keyboard(
                      event,
                      id,
                      tabs.map((entry) => entry.id),
                      "horizontal",
                    )
                  }
                  onClick={() => onSelect(id)}
                >
                  {title}
                </button>
                {artifactId && unread.has(artifactId) && (
                  <span
                    className="unread-dot"
                    role="img"
                    aria-label="Updated artifact"
                    title="Artifact updated"
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={`tab-permanent${permanent ? " is-permanent" : ""}`}
                  data-tab-drag-ignore
                  aria-label={`${permanent ? "Make temporary" : "Keep permanently"}: ${title}`}
                  aria-pressed={permanent}
                  title={permanent ? "Permanent · Make temporary" : "Keep permanently"}
                  onClick={() => void onPermanent(id, !permanent)}
                >
                  <Bookmark fill={permanent ? "currentColor" : "none"} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="tab-close"
                  data-tab-drag-ignore
                  aria-label={`Close ${title}`}
                  title={permanent ? "Move to end of queue" : "Move to Trashcan"}
                  onClick={() => onClose(id)}
                >
                  <X />
                </Button>
              </div>
            );
          })}
        </div>
      </nav>
      <Button
        variant="ghost"
        size="icon"
        className="search-trigger"
        ref={controlsButton}
        aria-label="Search and controls"
        title="Search and controls · ⌘K"
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        onClick={onSearch}
      >
        <Search />
        {[...unread].some((id) => !openArtifacts.has(id)) && (
          <span className="unread-dot" aria-label="New artifacts" role="img" />
        )}
      </Button>
    </header>
  );
}
