import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Search, X } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import { tabArtifactId } from "../plugins/registry.renderer.ts";
import type { Tab } from "./contract.ts";
import { TabOverflow } from "./tab-overflow.tsx";

export function TabBar({
  tabs,
  selectedId,
  creating,
  artifacts,
  unread,
  tabButtons,
  controlsButton,
  searchOpen,
  overflowOpen,
  onOverflowChange,
  restoreOverflowFocus,
  onSelect,
  onReveal,
  onClose,
  onSearch,
}: {
  tabs: readonly Tab[];
  selectedId: string | null;
  creating: boolean;
  artifacts: ReadonlyMap<string, Artifact>;
  unread: ReadonlySet<string>;
  tabButtons: RefObject<Map<string, HTMLButtonElement>>;
  controlsButton: RefObject<HTMLButtonElement | null>;
  searchOpen: boolean;
  overflowOpen: boolean;
  onOverflowChange: (open: boolean) => void;
  restoreOverflowFocus: boolean;
  onSelect: (id: string, keyboard?: boolean) => void;
  onReveal: (id: string) => void;
  onClose: (id: string) => Promise<void>;
  onSearch: () => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const [capacity, setCapacity] = useState({ full: 1, overflow: 1 });
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
      setCapacity({
        full: Math.floor(width / tabWidth),
        overflow: Math.floor((width - pickerWidth) / tabWidth),
      });
    };
    const resize = new ResizeObserver(measure);
    measure();
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const count = Math.max(1, tabs.length <= capacity.full ? capacity.full : capacity.overflow);
  let visibleTabs = tabs.slice(-count);
  const selected = tabs.find((tab) => tab.id === selectedId);
  if (selected && !visibleTabs.includes(selected))
    visibleTabs = [selected, ...visibleTabs.slice(1)];
  const visibleIds = new Set(visibleTabs.map((tab) => tab.id));
  const hiddenIds = new Set(tabs.filter((tab) => !visibleIds.has(tab.id)).map((tab) => tab.id));
  const openArtifacts = new Set(tabs.map(tabArtifactId));
  useLayoutEffect(() => {
    if (!hiddenIds.size) onOverflowChange(false);
  }, [hiddenIds.size, onOverflowChange]);
  function navigateTabs(event: ReactKeyboardEvent) {
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
        {hiddenIds.size > 0 && (
          <TabOverflow
            tabs={tabs}
            hiddenIds={hiddenIds}
            artifacts={artifacts}
            unread={unread}
            tabButtons={tabButtons}
            onSelect={onReveal}
            open={overflowOpen}
            onOpenChange={onOverflowChange}
            restoreFocus={restoreOverflowFocus}
          />
        )}
        <div className="contents" role="tablist" aria-label="Artifacts" onKeyDown={navigateTabs}>
          {visibleTabs.map((tab) => {
            const { id } = tab;
            const artifactId = tabArtifactId(tab);
            const artifact = artifacts.get(artifactId ?? "");
            const title = artifact?.title ?? tab.title;
            const isSelected = id === selectedId && !creating;
            return (
              <div className={`artifact-tab${isSelected ? " selected" : ""}`} key={id}>
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
                  className="tab-close"
                  aria-label={`Close ${title}`}
                  title="Close tab"
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
