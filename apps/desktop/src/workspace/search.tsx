import { useRef, type Ref, type RefObject } from "react";
import { File, Search, Settings, X, type LucideIcon } from "lucide-react";
import type { Artifact } from "@irudd-scope/protocol";
import { Button } from "../renderer/components/ui/button.tsx";
import { Input } from "../renderer/components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../renderer/components/ui/dialog.tsx";
import { matchingSettings } from "../renderer/settings-section.tsx";

interface WorkspaceAction {
  id: string;
  title: string;
  keywords: string;
  icon: LucideIcon;
  onSelect: () => void;
  pressed?: boolean;
  shortcut?: string;
}

function ActionButton({ action }: { action: WorkspaceAction }) {
  const Icon = action.icon;
  return (
    <Button
      variant="ghost"
      className="control-action"
      data-search-result
      aria-pressed={action.pressed}
      title={action.shortcut ? `${action.title} · ${action.shortcut}` : action.title}
      onClick={action.onSelect}
    >
      <Icon aria-hidden="true" className="control-action-icon" />
      <span>{action.title}</span>
    </Button>
  );
}

export function WorkspaceSearch({
  open,
  onOpenChange,
  query,
  setQuery,
  artifacts,
  onOpenArtifact,
  actions,
  currentTab,
  onOpenSettings,
  finalFocus,
  guestControlsRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  artifacts: readonly Artifact[];
  onOpenArtifact: (id: string) => void;
  actions: readonly WorkspaceAction[];
  currentTab?: { title: string; actions: readonly WorkspaceAction[]; guestOwner?: string };
  guestControlsRef: Ref<HTMLDivElement>;
  onOpenSettings: (filter?: string) => void;
  finalFocus: boolean | RefObject<HTMLElement | null>;
}) {
  const results = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  function navigateResults(event: KeyboardEvent) {
    if (event.defaultPrevented || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    const candidates = Array.from(
      results.current?.querySelectorAll<HTMLElement>("[data-search-result]:not(:disabled)") ?? [],
    ).filter(
      (element) =>
        element.checkVisibility({ visibilityProperty: true }) &&
        (!element.dataset.searchKeywords ||
          element.dataset.searchKeywords.toLowerCase().includes(query.trim().toLowerCase())),
    );
    if (!candidates.length) return;
    const index = candidates.indexOf(document.activeElement as HTMLElement);
    if (index < 0 && document.activeElement !== input.current) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : candidates.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length;
      candidates[next]?.focus();
    } else if (index < 0 && query.trim()) {
      event.preventDefault();
      const first = candidates[0]!;
      if (first.tagName === "SUMMARY") {
        first.focus();
        if (!first.closest("details")?.open) first.click();
      } else first.click();
    }
  }
  const needle = query.trim().toLowerCase();
  const matches = artifacts
    .filter(
      (artifact) =>
        needle &&
        `${artifact.title} ${artifact.kind} ${Object.values(artifact.source ?? {}).join(" ")}`
          .toLowerCase()
          .includes(needle),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const matchingActions = (entries: readonly WorkspaceAction[]) =>
    entries.filter((action) => `${action.title} ${action.keywords}`.toLowerCase().includes(needle));
  const controls = matchingActions(actions);
  const tabActions = matchingActions(currentTab?.actions ?? []);
  const settingMatches = needle ? matchingSettings(needle) : [];
  const guestControls =
    !!currentTab?.guestOwner &&
    `guest owner source actions rename title retention trash form input recovery shared ${currentTab.guestOwner}`
      .toLowerCase()
      .includes(needle);
  const hasResults =
    matches.length ||
    controls.length ||
    tabActions.length ||
    settingMatches.length ||
    guestControls;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="search-dialog"
        finalFocus={finalFocus}
        ref={(element) => {
          if (!element) return;
          // Guest controls are React portals owned by their tabs; keyboard navigation follows the dialog DOM.
          element.addEventListener("keydown", navigateResults);
          return () => element.removeEventListener("keydown", navigateResults);
        }}
      >
        <div className="search-header">
          <DialogHeader>
            <DialogTitle>Search and controls</DialogTitle>
          </DialogHeader>
          <div className="workspace-search-field">
            <Search aria-hidden="true" />
            <Input
              ref={input}
              aria-label="Search artifacts"
              placeholder="Search artifacts, actions, and settings…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  input.current?.focus();
                }}
              >
                <X />
              </Button>
            )}
          </div>
        </div>
        <div className={`search-body${needle ? " searching" : ""}`} ref={results}>
          {(controls.length > 0 || tabActions.length > 0 || guestControls) && (
            <div className="workspace-controls">
              {controls.length > 0 && (
                <section className="app-controls" aria-label="Workspace controls">
                  <h2>Workspace</h2>
                  <div className="control-grid">
                    {controls.map((action) => (
                      <ActionButton key={action.id} action={action} />
                    ))}
                  </div>
                </section>
              )}
              {currentTab && (tabActions.length > 0 || guestControls) && (
                <section className="current-tab-controls" aria-label="Current tab">
                  <h2>Current tab</h2>
                  <p className="current-tab-title">{currentTab.title}</p>
                  {guestControls && <p className="secondary">Shared by {currentTab.guestOwner}</p>}
                  <div className="control-grid">
                    {tabActions.map((action) => (
                      <ActionButton key={action.id} action={action} />
                    ))}
                  </div>
                  {guestControls && <div ref={guestControlsRef} />}
                </section>
              )}
            </div>
          )}
          {settingMatches.length > 0 && (
            <section className="search-section" aria-label="Settings results">
              <h2>Settings</h2>
              <div className="artifact-list">
                {settingMatches.map((section) => (
                  <button data-search-result key={section.id} onClick={() => onOpenSettings(query)}>
                    <Settings aria-hidden="true" />
                    <span>{section.title}</span>
                    <small>Setting</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {matches.length > 0 && (
            <section className="search-section" aria-label="Artifact results">
              <h2>Artifacts</h2>
              <div className="artifact-list">
                {matches.map((artifact) => (
                  <button
                    data-search-result
                    key={artifact.id}
                    onClick={() => onOpenArtifact(artifact.id)}
                  >
                    <File aria-hidden="true" />
                    <span>{artifact.title}</span>
                    <small>{artifact.kind}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {!hasResults && needle && (
            <p className="search-empty" role="status">
              No matches. Try another title, action, or setting.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
