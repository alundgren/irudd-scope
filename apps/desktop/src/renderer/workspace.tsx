import { useEffect, useState } from "react";
import { Download, Maximize2, Minimize2, Search, Settings, X, Info } from "lucide-react";
import type { Artifact } from "@irudd-scope/protocol";
import type { Snapshot } from "../bridge.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { SettingsViewPanel } from "./settings-view.tsx";
import { ArtifactView } from "./artifact-view.tsx";
import { CreateDiagram } from "./create-diagram.tsx";

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
    /* Unavailable workspace preferences must not block saved artifacts. */
  }
  return { tabs: [], selected: null };
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ artifacts: [], connection: "connecting" });
  const [workspace, setWorkspace] = useState<Workspace>({ tabs: [], selected: null });
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.selected ? artifacts.get(workspace.selected) : undefined;
  useEffect(() => {
    const unsubscribe = window.scope.onSnapshot(setSnapshot);
    void window.scope
      .snapshot()
      .then(setSnapshot)
      .catch(() => setError("Could not read the desktop connection."));
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
    void window.scope.saveWorkspace(workspace).catch(() => setError("Could not save open tabs."));
  }, [workspace, workspaceReady, workspaceLoaded]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(false);
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);
  function open(artifact: Artifact) {
    setWorkspace((previous) => ({
      tabs: previous.tabs.includes(artifact.id) ? previous.tabs : [...previous.tabs, artifact.id],
      selected: artifact.id,
    }));
    setSearch(false);
    setSettings(false);
    setCreating(false);
  }
  function close(id: string) {
    setWorkspace((previous) => {
      const index = previous.tabs.indexOf(id);
      const tabs = previous.tabs.filter((tab) => tab !== id);
      return {
        tabs,
        selected:
          previous.selected === id ? (tabs[Math.max(0, index - 1)] ?? null) : previous.selected,
      };
    });
  }
  async function download() {
    if (!active) return;
    try {
      await window.scope.download(active.id, active.revision);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Download failed.");
    }
  }
  if (!workspaceReady) return <p role="status">Opening workspace…</p>;
  return (
    <main className={`workspace${focus ? " focus-mode" : ""}`}>
      {!focus && (
        <header className="workspace-bar">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Find artifacts and tools"
            title="Find artifacts · ⌘K"
            onClick={() => setSearch(true)}
          >
            <Search />
          </Button>
          <nav className="tabs" aria-label="Open artifacts">
            {workspace.tabs.map((id) => {
              const artifact = artifacts.get(id);
              return (
                <div
                  className={`artifact-tab${id === workspace.selected && !settings ? " selected" : ""}`}
                  key={id}
                >
                  <button
                    className="tab-title"
                    title={artifact?.title ?? id}
                    onClick={() => {
                      setWorkspace((value) => ({ ...value, selected: id }));
                      setSettings(false);
                    }}
                  >
                    {artifact?.title ?? id}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close ${artifact?.title ?? id}`}
                    onClick={() => close(id)}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </nav>
          <span
            className={`connection ${snapshot.connection}`}
            title={snapshot.error ?? snapshot.connection}
            aria-label={`Local storage ${snapshot.connection}`}
          />
          {active && !settings && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Artifact details"
                onClick={() => setDetails(true)}
              >
                <Info />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Download"
                onClick={() => void download()}
              >
                <Download />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Focus artifact"
                onClick={() => setFocus(true)}
              >
                <Maximize2 />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <Settings />
          </Button>
        </header>
      )}
      {focus && (
        <Button
          variant="secondary"
          size="icon-sm"
          className="exit-focus"
          aria-label="Exit focus mode"
          title="Exit focus · Escape"
          onClick={() => setFocus(false)}
        >
          <Minimize2 />
        </Button>
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
      <div className="workspace-content">
        {settings ? (
          <SettingsViewPanel onClose={() => setSettings(false)} />
        ) : creating ? (
          <CreateDiagram
            onClose={() => setCreating(false)}
            onCreated={(artifact) => {
              setSnapshot((value) => ({
                ...value,
                artifacts: [
                  ...value.artifacts.filter((entry) => entry.id !== artifact.id),
                  artifact,
                ],
              }));
              open(artifact);
            }}
          />
        ) : active ? (
          <ArtifactView artifact={active} />
        ) : (
          <section className="empty-state">
            <h1>Things your agents leave for you</h1>
            <p>Open an artifact to inspect it.</p>
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Create diagram
            </Button>
            {snapshot.connection === "offline" && <p role="status">{snapshot.error}</p>}
            {snapshot.artifacts.length ? (
              <div className="artifact-list">
                {snapshot.artifacts
                  .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((artifact) => (
                    <button key={artifact.id} onClick={() => open(artifact)}>
                      <span>{artifact.title}</span>
                      <small>{artifact.kind}</small>
                    </button>
                  ))}
              </div>
            ) : (
              <code>irudd-scope add report.html --title "Review"</code>
            )}
          </section>
        )}
      </div>
      <Dialog open={search} onOpenChange={setSearch}>
        <DialogContent className="search-dialog">
          <DialogHeader>
            <DialogTitle>Find artifacts and tools</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="Search artifacts"
            placeholder="Search by title, kind, or source…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <div className="artifact-list">
            {"create diagram".includes(query.toLowerCase()) && (
              <button
                onClick={() => {
                  setCreating(true);
                  setSettings(false);
                  setSearch(false);
                }}
              >
                <span>Create diagram</span>
                <small>Tool</small>
              </button>
            )}
            {snapshot.artifacts
              .filter((artifact) =>
                `${artifact.title} ${artifact.kind} ${JSON.stringify(artifact.source ?? {})}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((artifact) => (
                <button key={artifact.id} onClick={() => open(artifact)}>
                  <span>{artifact.title}</span>
                  <small>{artifact.kind}</small>
                </button>
              ))}
            {"settings".includes(query.toLowerCase()) && (
              <button
                onClick={() => {
                  setSettings(true);
                  setSearch(false);
                }}
              >
                <span>Settings</span>
                <small>Tool</small>
              </button>
            )}
          </div>
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
