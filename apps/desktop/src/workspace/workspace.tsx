import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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
import { Button } from "../renderer/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../renderer/components/ui/dialog.tsx";
import { SettingsViewPanel } from "../renderer/settings-view.tsx";
import { useAppearance, type Appearance } from "../renderer/appearance.ts";
import { useArtifactLibrary } from "../library/use-library.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WorkspaceSearch } from "./search.tsx";

import type { Tab } from "./contract.ts";
import { TabHost } from "./tab-host.tsx";
import { TabEventRouter } from "./events.ts";
import { pluginTools, pluginForArtifact, tabArtifactId } from "../plugins/registry.renderer.ts";

export function App({ initialAppearance }: { initialAppearance: Appearance }) {
  const { theme, setAppearance } = useAppearance(initialAppearance);
  const [settings, setSettings] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const Creation = pluginTools.find((tool) => tool.id === creating)?.View;
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
    updateTab,
    updateState,
  } = useWorkspace(setError);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.tabs.find((tab) => tab.id === workspace.selected);
  const activeArtifact = active ? artifacts.get(tabArtifactId(active) ?? "") : undefined;
  const [events] = useState(
    () => new TabEventRouter(() => setError("A tab could not handle an event.")),
  );
  events.update(workspace.tabs);
  useEffect(
    () =>
      events.subscribe((envelope) => {
        void workspaceSave
          .flush()
          .then(() => window.scope.publishTabEvent(envelope))
          .catch(() => setError("Could not deliver a tab event to the desktop."));
      }),
    [events, workspaceSave.flush],
  );
  useEffect(() => {
    for (const tab of [...workspace.tabs, ...workspace.closed]) {
      const artifact = artifacts.get(tabArtifactId(tab) ?? "");
      if (!artifact) continue;
      const type = pluginForArtifact(artifact).type;
      if (tab.type !== type || tab.title !== artifact.title)
        updateTab(tab.id, { type, title: artifact.title });
    }
  }, [snapshot.artifacts, workspace.tabs, workspace.closed]);
  useEffect(() => {
    tabButtons.current
      .get(workspace.selected ?? "")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selected, workspace.tabs, focus]);

  function activate(tab: Tab, keyboard = false) {
    if (!openTab(tab)) return;
    const artifactId = tabArtifactId(tab);
    if (artifactId) markRead(artifactId);
    setSearch(false);
    setCreating(null);
    if (keyboard) requestAnimationFrame(() => tabButtons.current.get(tab.id)?.focus());
  }
  function select(id: string, keyboard = false) {
    const tab = workspace.tabs.find((entry) => entry.id === id);
    if (tab) activate(tab, keyboard);
  }
  function open(id: string) {
    const artifact = artifacts.get(id);
    if (!artifact) return;
    const plugin = pluginForArtifact(artifact);
    const existing = [...workspace.tabs, ...workspace.closed].find(
      (tab) => tabArtifactId(tab) === id,
    );
    activate(
      existing ?? {
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: plugin.type,
        title: artifact.title,
        state: plugin.publication!.state(artifact),
      },
    );
  }
  async function close(id: string) {
    if (!(await closeTab(id))) return;
    const index = workspace.tabs.findIndex((tab) => tab.id === id);
    const tabs = workspace.tabs.filter((tab) => tab.id !== id);
    const selected =
      workspace.selected === id ? (tabs[Math.max(0, index - 1)]?.id ?? null) : workspace.selected;
    if (!tabs.length) setFocus(false);
    requestAnimationFrame(() => tabButtons.current.get(selected ?? "")?.focus());
  }
  function reopen() {
    const tab = workspace.closed.at(-1);
    if (tab) activate(tab, true);
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
    if (!activeArtifact) return;
    setMenu(false);
    try {
      await window.scope.download(activeArtifact.id, activeArtifact.revision);
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
    const index = workspace.tabs.findIndex((tab) => tab.id === workspace.selected);
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
    select(workspace.tabs[target].id, true);
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
              {workspace.tabs.map((tab) => {
                const { id } = tab;
                const artifactId = tabArtifactId(tab);
                const artifact = artifacts.get(artifactId ?? "");
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
                      title={artifact?.title ?? tab.title}
                      onClick={() => select(id)}
                    >
                      {artifact?.title ?? tab.title}
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
                      aria-label={`Close ${artifact?.title ?? tab.title}`}
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
            {[...unread].some((id) => !workspace.tabs.some((tab) => tabArtifactId(tab) === id)) && (
              <span className="unread-dot" aria-label="New artifacts" role="img" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Focus artifact"
            title="Focus artifact · ⌘⇧F"
            disabled={!active || Boolean(creating)}
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
        {workspace.tabs.map((tab) => {
          const { id } = tab;
          const artifact = artifacts.get(tabArtifactId(tab) ?? "");
          return (
            <div
              className="artifact-pane"
              role="tabpanel"
              id={`pane-${id}`}
              aria-labelledby={focus ? undefined : `tab-${id}`}
              aria-label={artifact?.title ?? tab.title}
              key={id}
              hidden={id !== workspace.selected || Boolean(creating)}
            >
              <TabHost
                tab={tab}
                artifact={artifact}
                router={events}
                updateState={updateState}
                theme={theme}
                focus={focus && id === workspace.selected}
              />
            </div>
          );
        })}
        {Creation && (
          <div className="artifact-pane">
            <Suspense fallback={<p role="status">Opening tool…</p>}>
              <Creation
                onClose={() => setCreating(null)}
                onCreated={({ artifact, ...tab }) => {
                  if (artifact) recordPublication(artifact);
                  activate({
                    ...tab,
                    id: crypto.randomUUID(),
                    groupId: active?.groupId ?? workspace.groups[0].id,
                  });
                }}
              />
            </Suspense>
          </div>
        )}
        {!workspace.selected && !creating && (
          <div className="artifact-pane">
            <section className="empty-state">
              <h1>Things your agents leave for you</h1>
              <p>Open an artifact to inspect it.</p>
              {pluginTools.map((tool) => (
                <Button key={tool.id} variant="secondary" onClick={() => setCreating(tool.id)}>
                  <Plus /> {tool.title}
                </Button>
              ))}
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
            {pluginTools.map((tool) => (
              <button
                key={tool.id}
                onClick={() => {
                  setCreating(tool.id);
                  setMenu(false);
                  setFocus(false);
                }}
              >
                {tool.title}
                <Plus size={16} />
              </button>
            ))}
            <hr />
            <button
              disabled={!activeArtifact}
              onClick={() => {
                setDetails(true);
                setMenu(false);
              }}
            >
              Artifact details
              <Info size={16} />
            </button>
            <button disabled={!activeArtifact} onClick={() => void download()}>
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
        tools={pluginTools}
        onOpenTool={(id) => {
          setCreating(id);
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
            <DialogTitle>{activeArtifact?.title ?? "Artifact"}</DialogTitle>
          </DialogHeader>
          {activeArtifact && (
            <dl className="artifact-details">
              <dt>Kind</dt>
              <dd>{activeArtifact.kind}</dd>
              <dt>ID</dt>
              <dd>{activeArtifact.id}</dd>
              <dt>Revision</dt>
              <dd>{activeArtifact.revision}</dd>
              <dt>Updated</dt>
              <dd>{new Date(activeArtifact.updatedAt).toLocaleString()}</dd>
              {Object.entries(activeArtifact.source ?? {}).map(([name, value]) => (
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
