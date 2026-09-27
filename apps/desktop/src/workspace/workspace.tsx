import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Download, Maximize2, Minimize2, Search, Settings, X, Info, Plus } from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../renderer/components/ui/dialog.tsx";
import { SettingsViewPanel } from "../renderer/settings-view.tsx";
import { UpdateNotice } from "../renderer/installation-settings.tsx";
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
  const [creating, setCreating] = useState<string | null>(null);
  const Creation = pluginTools.find((tool) => tool.id === creating)?.View;
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const { snapshot, unread, arrivals, acknowledgeArrivals, markRead, recordPublication } =
    useArtifactLibrary(setError);
  const {
    workspace,
    ready: workspaceReady,
    save: workspaceSave,
    openTab,
    addTabs,
    closeTab,
    updateTab,
    updateState,
  } = useWorkspace(setError);
  const receivingArrivals = useRef(false);
  useEffect(() => {
    if (!workspace.tabs.length) setFocus(false);
  }, [workspace.tabs.length]);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const controlsButton = useRef<HTMLButtonElement>(null);
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.tabs.find((tab) => tab.id === workspace.selected);
  const activeArtifact = active ? artifacts.get(tabArtifactId(active) ?? "") : undefined;
  useEffect(() => {
    if (activeArtifact) markRead(activeArtifact.id);
  }, [activeArtifact?.id, activeArtifact?.revision]);
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
    for (const tab of workspace.tabs) {
      const artifact = artifacts.get(tabArtifactId(tab) ?? "");
      if (!artifact) continue;
      const type = pluginForArtifact(artifact).type;
      if (tab.type !== type || tab.title !== artifact.title)
        updateTab(tab.id, { type, title: artifact.title });
    }
  }, [snapshot.artifacts, workspace.tabs]);
  useEffect(() => {
    if (!workspaceReady || creating || !arrivals.length || receivingArrivals.current) return;
    receivingArrivals.current = true;
    const existing = new Set(workspace.tabs.map(tabArtifactId));
    const tabs = arrivals.flatMap((id) => {
      const artifact = artifacts.get(id);
      if (!artifact || existing.has(id)) return [];
      const plugin = pluginForArtifact(artifact);
      return [
        {
          id: crypto.randomUUID(),
          groupId: workspace.groups[0].id,
          type: plugin.type,
          title: artifact.title,
          state: plugin.publication!.state(artifact),
        },
      ];
    });
    void addTabs(tabs)
      .then((selected) => {
        const selectedArtifact = tabs.find((tab) => tab.id === selected);
        if (selectedArtifact) markRead(tabArtifactId(selectedArtifact)!);
        acknowledgeArrivals(arrivals);
      })
      .finally(() => {
        receivingArrivals.current = false;
      });
  }, [arrivals, snapshot.artifacts, workspace, workspaceReady, creating]);
  useEffect(() => {
    tabButtons.current
      .get(workspace.selected ?? "")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selected, workspace.tabs, focus]);

  async function activate(tab: Tab, keyboard = false) {
    if (!(await openTab(tab))) return;
    const artifactId = tabArtifactId(tab);
    if (artifactId) markRead(artifactId);
    setSearch(false);
    setCreating(null);
    if (keyboard) requestAnimationFrame(() => tabButtons.current.get(tab.id)?.focus());
  }
  function select(id: string, keyboard = false) {
    const tab = workspace.tabs.find((entry) => entry.id === id);
    if (tab) void activate(tab, keyboard);
  }
  function open(id: string) {
    const artifact = artifacts.get(id);
    if (!artifact) return;
    const plugin = pluginForArtifact(artifact);
    const existing = workspace.tabs.find((tab) => tabArtifactId(tab) === id);
    void activate(
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
  function openSettings(filter = "") {
    setSettingsQuery(filter);
    setSettings(true);
    setDetails(false);
    setSearch(false);
  }
  function openSearch() {
    setSettings(false);
    setDetails(false);
    setQuery("");
    setSearch(true);
  }
  async function download() {
    if (!activeArtifact) return;
    setSearch(false);
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
      } else if (search || settings || details) return;
      else if (event.key === "Escape" && focus) {
        event.preventDefault();
        setFocus(false);
      } else if (
        command &&
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        active &&
        !creating
      ) {
        event.preventDefault();
        setFocus((value) => !value);
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
            ref={controlsButton}
            aria-label="Search and controls"
            title="Search and controls · ⌘K"
            aria-haspopup="dialog"
            aria-expanded={search}
            onClick={openSearch}
          >
            <Search />
            {[...unread].some((id) => !workspace.tabs.some((tab) => tabArtifactId(tab) === id)) && (
              <span className="unread-dot" aria-label="New artifacts" role="img" />
            )}
          </Button>
        </header>
      )}
      {focus && (
        <Button
          variant="secondary"
          size="sm"
          className="exit-focus"
          ref={controlsButton}
          aria-label="Exit focus mode"
          title="Exit focus · Escape"
          onClick={() => setFocus(false)}
        >
          <Minimize2 /> Back to tabs
        </Button>
      )}
      {workspaceSave.error && (
        <div className="error-bar" role="alert">
          Could not save open tabs.
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
      {!focus && <UpdateNotice />}
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
                  void activate({
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
      <WorkspaceSearch
        open={search}
        onOpenChange={setSearch}
        query={query}
        setQuery={setQuery}
        artifacts={snapshot.artifacts}
        onOpenArtifact={open}
        onOpenSettings={openSettings}
        finalFocus={settings || details ? false : controlsButton}
        actions={[
          {
            id: "settings",
            title: "Settings",
            keywords: "preferences",
            icon: Settings,
            shortcut: "⌘,",
            onSelect: () => openSettings(),
          },
          ...(active && !creating
            ? [
                {
                  id: "fullscreen",
                  title: focus ? "Exit fullscreen" : "Fullscreen",
                  keywords: "full screen focus expand",
                  icon: focus ? Minimize2 : Maximize2,
                  shortcut: "⌘⇧F",
                  pressed: focus,
                  onSelect: () => {
                    setFocus((value) => !value);
                    setSearch(false);
                  },
                },
              ]
            : []),
          ...pluginTools.map((tool) => ({
            id: tool.id,
            title: tool.title,
            keywords: tool.keywords,
            icon: Plus,
            onSelect: () => {
              setCreating(tool.id);
              setSearch(false);
              setFocus(false);
            },
          })),
        ]}
        currentTab={
          active && !creating
            ? {
                title: activeArtifact?.title ?? active.title,
                actions: [
                  ...(activeArtifact
                    ? [
                        {
                          id: "download",
                          title: "Download",
                          keywords: "export save file",
                          icon: Download,
                          onSelect: () => void download(),
                        },
                        {
                          id: "details",
                          title: "Artifact details",
                          keywords: "info source revision",
                          icon: Info,
                          onSelect: () => {
                            setDetails(true);
                            setSearch(false);
                          },
                        },
                      ]
                    : []),
                  {
                    id: "close",
                    title: "Close tab",
                    keywords: "delete remove",
                    icon: X,
                    shortcut: "⌘W",
                    onSelect: () => {
                      setSearch(false);
                      void close(active.id);
                    },
                  },
                ],
              }
            : undefined
        }
      />
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="settings-dialog" finalFocus={search ? false : controlsButton}>
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
        <DialogContent finalFocus={search ? false : controlsButton}>
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
