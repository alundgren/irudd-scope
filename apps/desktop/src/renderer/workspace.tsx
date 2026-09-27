import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Download,
  Maximize2,
  Minimize2,
  Search,
  Settings,
  X,
  Info,
  Menu,
  Plus,
} from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { SettingsViewPanel } from "./settings-view.tsx";
import { ArtifactView } from "./artifact-view.tsx";
import { CreateDiagram } from "./create-diagram.tsx";
import { useAppearance, type Appearance } from "./appearance.ts";
import { useArtifactLibrary } from "./use-artifact-library.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WorkspaceSearch } from "./workspace-search.tsx";

export function App({ initialAppearance }: { initialAppearance: Appearance }) {
  const { theme, setAppearance } = useAppearance(initialAppearance);
  const [settings, setSettings] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const { snapshot, unread, markRead, recordPublication } = useArtifactLibrary(setError);
  const {
    workspace,
    ready: workspaceReady,
    save: workspaceSave,
    openTab,
    closeTab,
  } = useWorkspace(setError);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.selected ? artifacts.get(workspace.selected) : undefined;
  useEffect(() => {
    tabButtons.current
      .get(workspace.selected ?? "")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selected, workspace.tabs, focus]);

  function open(id: string, keyboard = false) {
    if (!openTab(id)) return;
    markRead(id);
    setSearch(false);
    setCreating(false);
    if (keyboard) requestAnimationFrame(() => tabButtons.current.get(id)?.focus());
  }
  async function close(id: string) {
    if (!(await closeTab(id))) return;
    const index = workspace.tabs.indexOf(id);
    const tabs = workspace.tabs.filter((tab) => tab !== id);
    const selected =
      workspace.selected === id ? (tabs[Math.max(0, index - 1)] ?? null) : workspace.selected;
    if (!tabs.length) setFocus(false);
    requestAnimationFrame(() => tabButtons.current.get(selected ?? "")?.focus());
  }
  function reopen() {
    const id = workspace.closed?.at(-1);
    if (!id) return;
    open(id, true);
  }
  function openSettings(filter = "") {
    setSettingsQuery(filter);
    setSettings(true);
    setMenu(false);
    setSearch(false);
  }
  function openSearch() {
    setQuery("");
    setSearch(true);
    setMenu(false);
  }
  async function download() {
    if (!active) return;
    setMenu(false);
    try {
      await window.scope.download(active.id, active.revision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Download failed.");
    }
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      } else if (command && event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if (menu || search || settings || details) return;
      else if (event.key === "Escape" && focus) {
        event.preventDefault();
        setFocus(false);
      } else if (command && event.shiftKey && event.key.toLowerCase() === "f" && active) {
        event.preventDefault();
        setFocus((value) => !value);
      } else if (command && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        reopen();
      } else if (command && event.key.toLowerCase() === "w" && workspace.selected) {
        event.preventDefault();
        void close(workspace.selected);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });
  function navigateTabs(event: ReactKeyboardEvent) {
    const index = workspace.tabs.indexOf(workspace.selected ?? "");
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % workspace.tabs.length
        : event.key === "ArrowLeft"
          ? (index + workspace.tabs.length - 1) % workspace.tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? workspace.tabs.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    open(workspace.tabs[target], true);
  }
  if (!workspaceReady) return <p role="status">Opening workspace…</p>;
  return (
    <main className={`workspace${focus ? " focus-mode" : ""}`}>
      {!focus && (
        <header className="workspace-bar">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Workspace menu"
            title="Workspace menu"
            onClick={() => setMenu(true)}
          >
            <Menu />
          </Button>
          <nav className="tabs" aria-label="Open artifacts">
            <div
              className="contents"
              role="tablist"
              aria-label="Artifacts"
              onKeyDown={navigateTabs}
            >
              {workspace.tabs.map((id) => {
                const artifact = artifacts.get(id);
                const selected = id === workspace.selected && !creating;
                return (
                  <div className={`artifact-tab${selected ? " selected" : ""}`} key={id}>
                    <button
                      ref={(element) => {
                        if (element) tabButtons.current.set(id, element);
                        else tabButtons.current.delete(id);
                      }}
                      className="tab-title"
                      id={`tab-${id}`}
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`pane-${id}`}
                      tabIndex={id === workspace.selected ? 0 : -1}
                      title={artifact?.title ?? id}
                      onClick={() => open(id)}
                    >
                      {artifact?.title ?? id}
                    </button>
                    {unread.has(id) && (
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
                      aria-label={`Close ${artifact?.title ?? id}`}
                      title="Close tab"
                      onClick={() => close(id)}
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
            aria-label="Find artifacts and tools"
            title="Find artifacts · ⌘K"
            onClick={openSearch}
          >
            <Search />
            {[...unread].some((id) => !workspace.tabs.includes(id)) && (
              <span className="unread-dot" aria-label="New artifacts" role="img" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Focus artifact"
            title="Focus artifact · ⌘⇧F"
            disabled={!active || creating}
            onClick={() => setFocus(true)}
          >
            <Maximize2 />
          </Button>
        </header>
      )}
      {focus && (
        <Button
          variant="secondary"
          size="sm"
          className="exit-focus"
          aria-label="Exit focus mode"
          title="Exit focus · Escape"
          onClick={() => setFocus(false)}
        >
          <Minimize2 /> Back to tabs
        </Button>
      )}
      {workspaceSave.error && (
        <div className="error-bar" role="alert">
          Could not save open and closed tabs.
          <Button size="sm" onClick={() => void workspaceSave.flush().catch(() => {})}>
            Retry
          </Button>
        </div>
      )}
      {error && (
        <div className="error-bar" role="alert">
          {error}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X />
          </Button>
        </div>
      )}
      {snapshot.connection === "offline" && (
        <div className="connection-notice" role="status">
          {snapshot.error ??
            "Reconnecting to the artifact library. Open content remains available."}
        </div>
      )}
      <div className="workspace-content">
        {workspace.tabs.map((id) => {
          const artifact = artifacts.get(id);
          return (
            <div
              className="artifact-pane"
              role="tabpanel"
              id={`pane-${id}`}
              aria-labelledby={`tab-${id}`}
              key={id}
              hidden={id !== workspace.selected || creating}
            >
              {artifact ? (
                <ArtifactView
                  artifact={artifact}
                  theme={theme}
                  focus={focus && id === workspace.selected}
                />
              ) : (
                <p className="empty-state" role="status">
                  Loading artifact…
                </p>
              )}
            </div>
          );
        })}
        {creating && (
          <div className="artifact-pane">
            <CreateDiagram
              onClose={() => setCreating(false)}
              onCreated={(artifact) => {
                recordPublication(artifact);
                open(artifact.id);
              }}
            />
          </div>
        )}
        {!workspace.selected && !creating && (
          <div className="artifact-pane">
            <section className="empty-state">
              <h1>Things your agents leave for you</h1>
              <p>Open an artifact to inspect it.</p>
              <Button variant="secondary" onClick={() => setCreating(true)}>
                <Plus /> Create diagram
              </Button>
              {snapshot.artifacts.length ? (
                <div className="artifact-list">
                  {snapshot.artifacts
                    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map((artifact) => (
                      <button key={artifact.id} onClick={() => open(artifact.id)}>
                        <span>{artifact.title}</span>
                        <small>{artifact.kind}</small>
                      </button>
                    ))}
                </div>
              ) : (
                <code>irudd-scope add report.html --title "Review"</code>
              )}
            </section>
          </div>
        )}
      </div>
      <Dialog open={menu} onOpenChange={setMenu}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Workspace</DialogTitle>
          </DialogHeader>
          <div className="menu-actions">
            <button onClick={openSearch}>
              <span>Search artifacts and tools</span>
              <kbd>⌘ K</kbd>
            </button>
            <button onClick={() => openSettings()}>
              <span>Settings</span>
              <Settings size={16} />
            </button>
            <button
              onClick={() => {
                setCreating(true);
                setMenu(false);
                setFocus(false);
              }}
            >
              Create diagram
              <Plus size={16} />
            </button>
            <hr />
            <button
              disabled={!active}
              onClick={() => {
                setDetails(true);
                setMenu(false);
              }}
            >
              Artifact details
              <Info size={16} />
            </button>
            <button disabled={!active} onClick={() => void download()}>
              Download
              <Download size={16} />
            </button>
            <button
              disabled={!workspace.closed?.length}
              onClick={() => {
                reopen();
                setMenu(false);
              }}
            >
              Reopen closed tab<kbd>⌘ ⇧ T</kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <WorkspaceSearch
        open={search}
        onOpenChange={setSearch}
        query={query}
        setQuery={setQuery}
        artifacts={snapshot.artifacts}
        onOpenArtifact={open}
        onOpenSettings={openSettings}
        onCreateDiagram={() => {
          setCreating(true);
          setSearch(false);
          setFocus(false);
        }}
      />
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <SettingsViewPanel
            key={settingsQuery}
            initialQuery={settingsQuery}
            onClose={() => setSettings(false)}
            onAppearanceChange={setAppearance}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{active?.title ?? "Artifact"}</DialogTitle>
          </DialogHeader>
          {active && (
            <dl className="artifact-details">
              <dt>Kind</dt>
              <dd>{active.kind}</dd>
              <dt>ID</dt>
              <dd>{active.id}</dd>
              <dt>Revision</dt>
              <dd>{active.revision}</dd>
              <dt>Updated</dt>
              <dd>{new Date(active.updatedAt).toLocaleString()}</dd>
              {Object.entries(active.source ?? {}).map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
