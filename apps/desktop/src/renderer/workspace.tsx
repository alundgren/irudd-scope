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
import type { Snapshot } from "../bridge.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { SettingsViewPanel, matchingSettings } from "./settings-view.tsx";
import { ArtifactView } from "./artifact-view.tsx";
import { CreateDiagram } from "./create-diagram.tsx";
import { useAppearance, type Appearance } from "./appearance.ts";
import { flushWorkspace, useAutosave } from "./persistence.ts";

import type { Workspace } from "../settings.ts";

function legacyWorkspace(): Workspace {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("scope.workspace.v1") ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "tabs" in value &&
      Array.isArray(value.tabs) &&
      value.tabs.length <= 100 &&
      value.tabs.every((id) => typeof id === "string") &&
      "selected" in value &&
      (typeof value.selected === "string" || value.selected === null)
    )
      return { tabs: value.tabs, selected: value.selected };
  } catch {
    /* Saved tabs are optional. */
  }
  return { tabs: [], selected: null };
}

export function App({ initialAppearance }: { initialAppearance: Appearance }) {
  const { theme, setAppearance } = useAppearance(initialAppearance);
  const [snapshot, setSnapshot] = useState<Snapshot>({ artifacts: [], connection: "connecting" });
  const [workspace, setWorkspace] = useState<Workspace>({ tabs: [], selected: null });
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const revisions = useRef<Map<string, number> | null>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const results = useRef<HTMLDivElement>(null);
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.selected ? artifacts.get(workspace.selected) : undefined;
  const workspaceSave = useAutosave(
    () => (workspaceLoaded ? workspace : undefined),
    (value) => window.scope.saveWorkspace(value),
  );

  useEffect(() => window.scope.onBeforeClose(flushWorkspace), []);

  useEffect(() => {
    const receive = (next: Snapshot) => {
      if (revisions.current) {
        const changed = next.artifacts.filter(
          (artifact) => revisions.current!.get(artifact.id) !== artifact.revision,
        );
        if (changed.length)
          setUnread(
            (previous) => new Set([...previous, ...changed.map((artifact) => artifact.id)]),
          );
      }
      if (next.connection === "connected")
        revisions.current = new Map(
          next.artifacts.map((artifact) => [artifact.id, artifact.revision]),
        );
      setSnapshot(next);
    };
    const unsubscribe = window.scope.onSnapshot(receive);
    void window.scope
      .snapshot()
      .then(receive)
      .catch(() => setError("Could not read the artifact library."));
    return unsubscribe;
  }, []);
  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await window.scope.workspace();
      const initial = saved ?? legacyWorkspace();
      if (saved === null) await window.scope.saveWorkspace(initial);
      try {
        localStorage.removeItem("scope.workspace.v1");
      } catch {
        /* Legacy storage may be unavailable. */
      }
      if (active) {
        setWorkspace(initial);
        setWorkspaceLoaded(true);
      }
    })()
      .catch(() => {
        if (active) setError("Could not load saved tabs. Your artifacts remain on this Mac.");
      })
      .finally(() => {
        if (active) setWorkspaceReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!workspaceReady || !workspaceLoaded) return;
    workspaceSave.schedule();
  }, [workspace, workspaceReady, workspaceLoaded]);
  useEffect(() => {
    tabButtons.current
      .get(workspace.selected ?? "")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selected, workspace.tabs, focus]);

  function open(id: string, keyboard = false) {
    if (!workspace.tabs.includes(id) && workspace.tabs.length >= 100) {
      setError("Close a tab before opening another. Your artifacts stay in the library.");
      return;
    }
    setWorkspace((previous) => ({
      tabs: previous.tabs.includes(id) ? previous.tabs : [...previous.tabs, id],
      selected: id,
      closed: previous.closed?.filter((entry) => entry !== id) ?? [],
    }));
    setUnread((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setSearch(false);
    setCreating(false);
    if (keyboard) requestAnimationFrame(() => tabButtons.current.get(id)?.focus());
  }
  async function close(id: string) {
    try {
      await flushWorkspace();
    } catch {
      setError("Could not save this tab. Keep it open and try closing it again.");
      return;
    }
    const index = workspace.tabs.indexOf(id);
    const tabs = workspace.tabs.filter((tab) => tab !== id);
    const selected =
      workspace.selected === id ? (tabs[Math.max(0, index - 1)] ?? null) : workspace.selected;
    setWorkspace((previous) => {
      if (!previous.tabs.includes(id)) return previous;
      const remaining = previous.tabs.filter((tab) => tab !== id);
      return {
        tabs: remaining,
        selected:
          previous.selected === id
            ? (remaining[Math.max(0, previous.tabs.indexOf(id) - 1)] ?? null)
            : previous.selected,
        closed: [...(previous.closed ?? []).filter((entry) => entry !== id), id],
      };
    });
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
  function navigateResults(event: ReactKeyboardEvent) {
    const buttons = Array.from(results.current?.querySelectorAll("button") ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[
        (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1) + buttons.length) %
          buttons.length
      ]?.focus();
    } else if (event.key === "Enter" && index < 0) {
      event.preventDefault();
      buttons[0]?.click();
    }
  }
  const needle = query.trim().toLowerCase();
  const matches = snapshot.artifacts
    .filter((artifact) =>
      `${artifact.title} ${artifact.kind} ${Object.values(artifact.source ?? {}).join(" ")}`
        .toLowerCase()
        .includes(needle),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const settingMatches = needle ? matchingSettings(needle) : [];
  const showCreate = "create diagram drawing".includes(needle);
  const showSettings = "settings preferences".includes(needle);

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
                revisions.current?.set(artifact.id, artifact.revision);
                setSnapshot((value) => ({
                  ...value,
                  artifacts: [
                    ...value.artifacts.filter((entry) => entry.id !== artifact.id),
                    artifact,
                  ],
                }));
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
      <Dialog open={search} onOpenChange={setSearch}>
        <DialogContent className="search-dialog" onKeyDown={navigateResults}>
          <DialogHeader>
            <DialogTitle>Find artifacts and tools</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Search artifacts"
            placeholder="Search artifacts, tools, and settings…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="artifact-list" ref={results}>
            {matches.map((artifact) => (
              <button key={artifact.id} onClick={() => open(artifact.id)}>
                <span>{artifact.title}</span>
                <small>{artifact.kind}</small>
              </button>
            ))}
            {showCreate && (
              <button
                onClick={() => {
                  setCreating(true);
                  setSearch(false);
                  setFocus(false);
                }}
              >
                <span>Create diagram</span>
                <small>Tool</small>
              </button>
            )}
            {showSettings && (
              <button onClick={() => openSettings()}>
                <span>Settings</span>
                <small>Tool</small>
              </button>
            )}
            {settingMatches.map((section) => (
              <button key={section.id} onClick={() => openSettings(query)}>
                <span>{section.title}</span>
                <small>Setting</small>
              </button>
            ))}
            {!matches.length && !showCreate && !showSettings && !settingMatches.length && (
              <p role="status">No matches. Try another title, tool, or setting.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
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
