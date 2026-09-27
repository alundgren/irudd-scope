import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Search, X } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import { tabArtifactId } from "../plugins/registry.renderer.ts";
import type { Tab } from "./contract.ts";

export function TabBar({
  tabs,
  selectedId,
  creating,
  artifacts,
  unread,
  tabButtons,
  controlsButton,
  searchOpen,
  onSelect,
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
  onSelect: (id: string, keyboard?: boolean) => void;
  onClose: (id: string) => Promise<void>;
  onSearch: () => void;
}) {
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
      <nav className="tabs" aria-label="Open artifacts">
        <div className="contents" role="tablist" aria-label="Artifacts" onKeyDown={navigateTabs}>
          {tabs.map((tab) => {
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
        {[...unread].some((id) => !tabs.some((tab) => tabArtifactId(tab) === id)) && (
          <span className="unread-dot" aria-label="New artifacts" role="img" />
        )}
      </Button>
    </header>
  );
}
