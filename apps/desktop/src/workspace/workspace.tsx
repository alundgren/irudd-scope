import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Maximize2,
  Minimize2,
  Settings,
  X,
  Info,
  Bookmark,
  Trash2,
  Send,
} from "lucide-react";
import { Button } from "../renderer/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "../renderer/components/ui/native-select.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../renderer/components/ui/dialog.tsx";
import { SettingsViewPanel } from "../renderer/settings-view.tsx";
import { SettingsDialog } from "../renderer/settings-dialog.tsx";
import { UpdateNotice } from "../renderer/installation-settings.tsx";
import { ImportTabDialog, PairScopeDialog, SendTabDialog } from "../renderer/transfer-dialog.tsx";
import type { Artifact } from "@irudd-scope/protocol";
import { isTransferKind } from "@irudd-scope/protocol/transfer";
import { useAppearance } from "../renderer/appearance.ts";
import { SettingsContext } from "../renderer/settings-context.tsx";
import type { SettingsView } from "../settings.ts";
import { useArtifactLibrary } from "../library/use-library.ts";
import { useTabRetention } from "./use-tab-retention.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WorkspaceSearch } from "./search.tsx";

import type { Tab } from "./contract.ts";
import { TabBar } from "./tab-bar.tsx";
import { FloatingOverlay } from "../renderer/components/ui/floating-overlay.tsx";
import { TabHost } from "./tab-host.tsx";
import { TabEventRouter } from "./events.ts";
import { PresentationPointer } from "./presentation-pointer.tsx";
import { observeFrameKeyboard } from "./frame-documents.ts";
import { pluginForArtifact, tabArtifactId } from "../plugins/registry.renderer.ts";

type FullscreenMode = "edit" | "view" | "present";
type TransferLink = { kind: "pair" | "tab"; url: string };
type TransferDialog = TransferLink | { kind: "send"; tabId: string; title: string };

export function App({ initialSettings }: { initialSettings: SettingsView | undefined }) {
  const { theme, setAppearance } = useAppearance(initialSettings?.appearance ?? "system");
  const [preferences, setPreferences] = useState(initialSettings);
  const [settings, setSettings] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState("");
  const [search, setSearch] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [fullscreenMode, setFullscreenMode] = useState<FullscreenMode>("edit");
  const [details, setDetails] = useState(false);
  const [transfer, setTransfer] = useState<TransferDialog>();
  const [transferLinks, setTransferLinks] = useState<TransferLink[]>([]);
  const pendingTransferLinks = useRef<TransferLink[]>([]);
  const transferOpen = transfer !== undefined;
  const [error, setError] = useState("");
  useEffect(
    () =>
      window.scope.onTransferLink(({ url, kind }) => {
        setSearch(false);
        const links = pendingTransferLinks.current;
        if (links.some((link) => link.url === url)) return;
        if (links.length === 4) {
          setError(
            "Four transfer links are waiting. Finish a transfer, then open the new link again.",
          );
          return;
        }
        pendingTransferLinks.current = [...links, { url, kind }];
        setTransferLinks(pendingTransferLinks.current);
      }),
    [],
  );
  useEffect(() => {
    if (transfer || settings || details || overflow || !transferLinks.length) return;
    const [next, ...pending] = pendingTransferLinks.current;
    setTransfer(next);
    pendingTransferLinks.current = pending;
    setTransferLinks(pending);
  }, [transfer, settings, details, overflow, transferLinks]);
  function closeTransfer(dialog: TransferDialog) {
    setTransfer((current) => (current === dialog ? undefined : current));
  }
  useEffect(
    () =>
      window.scope.onFullscreenChange((value) => {
        setOverflow(false);
        setFocus(value);
        if (!value) setFullscreenMode("edit");
      }),
    [],
  );
  useEffect(() => {
    void window.scope.setFullscreen(focus).catch(() => setError("Could not change fullscreen."));
  }, [focus]);
  const {
    snapshot,
    unread,
    arrivals,
    queueArrivals,
    acknowledgeArrivals,
    markRead,
    recordPublication,
  } = useArtifactLibrary(setError);
  const {
    workspace,
    ready: workspaceReady,
    save: workspaceSave,
    openTab,
    addTabs,
    closeTab,
    deferTab,
    moveTabToEnd,
    moveTab,
    updateTab,
    updateState,
    updateOverlayPosition,
  } = useWorkspace(setError);
  const retention = useTabRetention(workspaceReady, setError);
  // Moving an iframe resets its document, so panel order must be independent of tab order.
  const paneTabs = useMemo(
    () => workspace.tabs.toSorted((a, b) => a.id.localeCompare(b.id)),
    [workspace.tabs],
  );
  const [receivingArrivals, setReceivingArrivals] = useState(false);
  useEffect(() => {
    if (!workspace.tabs.length) {
      setFocus(false);
      setFullscreenMode("edit");
    }
  }, [workspace.tabs.length]);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const controlsButton = useRef<HTMLButtonElement>(null);
  const modeSelect = useRef<HTMLSelectElement>(null);
  const artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const active = workspace.tabs.find((tab) => tab.id === workspace.selected);
  const activeArtifact = active ? artifacts.get(tabArtifactId(active) ?? "") : undefined;
  const html = ["html", "plan", "pull-requests"].includes(activeArtifact?.kind ?? "");
  const hasModes = active?.type === "diagram" || html;
  const returnFocus = focus && hasModes ? modeSelect : controlsButton;
  const viewing = focus && active?.type === "diagram" && fullscreenMode !== "edit";
  const presentation = focus && hasModes && fullscreenMode === "present";
  const trashedArtifacts = new Set(
    retention.tabs
      .filter((entry) => entry.trashedAt !== null)
      .map((entry) => tabArtifactId(entry.tab)),
  );
  const activeUnread = new Set([...unread].filter((id) => !trashedArtifacts.has(id)));
  const activeArtifacts = snapshot.artifacts.filter(
    (artifact) => !trashedArtifacts.has(artifact.id),
  );
  const activePermanent =
    retention.tabs.find((entry) => entry.tab.id === active?.id)?.permanent ?? false;
  useEffect(() => {
    if (focus) retention.reportVisible(workspace.selected ? [workspace.selected] : []);
  }, [focus, workspace.selected, retention.reportVisible]);
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
    if (!workspaceReady || !retention.ready || snapshot.connection !== "connected") return;
    // A replacement publication can arrive before the old tab's close notification.
    const open = new Set(workspace.tabs.map(tabArtifactId));
    queueArrivals(activeArtifacts.filter((artifact) => !open.has(artifact.id)));
  }, [
    snapshot.artifacts,
    snapshot.connection,
    workspace.tabs,
    workspaceReady,
    retention.tabs,
    retention.ready,
  ]);
  useEffect(() => {
    if (!workspaceReady || !retention.ready || !arrivals.length || receivingArrivals) return;
    const existing = new Set(workspace.tabs.map(tabArtifactId));
    const pending = arrivals.filter(
      (artifact) => !existing.has(artifact.id) && !trashedArtifacts.has(artifact.id),
    );
    const alreadyOpen = arrivals.filter(
      (artifact) => existing.has(artifact.id) || trashedArtifacts.has(artifact.id),
    );
    if (!pending.length && !alreadyOpen.length) return;
    setReceivingArrivals(true);
    const tabs = pending.map((artifact) => {
      const plugin = pluginForArtifact(artifact);
      return {
        tab: {
          id: crypto.randomUUID(),
          groupId: workspace.groups[0].id,
          type: plugin.type,
          title: artifact.title,
          state: plugin.publication!.state(artifact),
        },
        artifactRevision: artifact.revision,
      };
    });
    void addTabs(tabs)
      .then((handled) => {
        const ids = new Set(handled.map(tabArtifactId));
        acknowledgeArrivals([
          ...alreadyOpen,
          ...pending.filter((artifact) => ids.has(artifact.id)),
        ]);
      })
      .catch(() => setError("Could not open arriving artifacts."))
      .finally(() => {
        setReceivingArrivals(false);
      });
  }, [arrivals, workspace, workspaceReady, receivingArrivals, retention.tabs, retention.ready]);
  useEffect(() => {
    tabButtons.current
      .get(workspace.selected ?? "")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspace.selected, workspace.tabs, focus]);

  async function activate(tab: Tab, keyboard = false, artifactRevision?: number) {
    if (
      !(await openTab(tab, artifactRevision ?? artifacts.get(tabArtifactId(tab) ?? "")?.revision))
    )
      return;
    const artifactId = tabArtifactId(tab);
    if (artifactId) markRead(artifactId);
    if (tab.id !== workspace.selected) setFullscreenMode("edit");
    setSearch(false);
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
  async function openImported(artifact: Artifact) {
    recordPublication(artifact);
    const saved = retention.tabs.find((entry) => tabArtifactId(entry.tab) === artifact.id);
    const existing = workspace.tabs.find((tab) => tabArtifactId(tab) === artifact.id);
    const plugin = pluginForArtifact(artifact);
    const tab = existing ??
      saved?.tab ?? {
        id: crypto.randomUUID(),
        groupId: workspace.groups[0].id,
        type: plugin.type,
        title: artifact.title,
        state: plugin.publication!.state(artifact),
      };
    await activate(tab, false, artifact.revision);
  }
  async function close(id: string) {
    if (!retention.ready) return;
    if (retention.tabs.find((entry) => entry.tab.id === id)?.permanent) {
      const selected = deferTab(id);
      if (workspace.selected === id) setFullscreenMode("edit");
      requestAnimationFrame(() => tabButtons.current.get(selected ?? "")?.focus());
      return;
    }
    await trash(id);
  }
  async function trash(id: string) {
    if (!(await closeTab(id))) return;
    const index = workspace.tabs.findIndex((tab) => tab.id === id);
    const tabs = workspace.tabs.filter((tab) => tab.id !== id);
    const selected =
      workspace.selected === id ? (tabs[Math.max(0, index - 1)]?.id ?? null) : workspace.selected;
    if (workspace.selected === id) setFullscreenMode("edit");
    if (!tabs.length) setFocus(false);
    requestAnimationFrame(() => tabButtons.current.get(selected ?? "")?.focus());
  }
  async function restore(id: string) {
    try {
      const tab = await window.scope.restoreTab(id);
      await activate(tab, true);
      moveTabToEnd(tab.id);
    } catch {
      setError("Could not restore this tab. Try again.");
    }
  }
  function openSettings(filter = "") {
    setOverflow(false);
    setSettingsQuery(filter);
    setSettings(true);
    setDetails(false);
    setSearch(false);
  }
  function openSearch() {
    setOverflow(false);
    setSettings(false);
    setDetails(false);
    setQuery("");
    setSearch(true);
  }
  function toggleFocus() {
    setOverflow(false);
    setFullscreenMode(!focus && html ? "view" : "edit");
    setFocus(!focus);
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
  // A visible tab change must update shortcuts before another key can target the old tab.
  useLayoutEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || transferOpen) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      } else if (command && event.key === ",") {
        event.preventDefault();
        openSettings();
      } else if (search || settings || details || overflow || transferOpen) return;
      else if (event.key === "Escape" && html && presentation) {
        event.preventDefault();
        setFullscreenMode("view");
      } else if (event.key === "Escape" && viewing) {
        event.preventDefault();
        setFullscreenMode("edit");
      } else if (event.key === "Escape" && focus) {
        event.preventDefault();
        toggleFocus();
      } else if (command && event.shiftKey && event.key.toLowerCase() === "f" && active) {
        event.preventDefault();
        toggleFocus();
      } else if (command && event.key.toLowerCase() === "w" && workspace.selected) {
        event.preventDefault();
        void close(workspace.selected);
      }
    };
    window.addEventListener("keydown", keyboard);
    const pane = active && document.getElementById(`pane-${active.id}`);
    const stopFrames = html && pane ? observeFrameKeyboard(pane, keyboard) : undefined;
    return () => {
      stopFrames?.();
      window.removeEventListener("keydown", keyboard);
    };
  });
  if (!workspaceReady) return <p role="status">Opening workspace…</p>;
  const content = (
    <main
      className={`workspace${focus ? " focus-mode" : ""}${presentation ? " presentation-mode" : ""}`}
    >
      {!focus && (
        <TabBar
          tabs={workspace.tabs}
          retainedTabs={retention.tabs}
          onPermanent={retention.setPermanent}
          onRestore={restore}
          onVisible={retention.reportVisible}
          selectedId={workspace.selected}
          artifacts={artifacts}
          unread={activeUnread}
          tabButtons={tabButtons}
          controlsButton={controlsButton}
          searchOpen={search}
          overflowOpen={overflow}
          onOverflowChange={setOverflow}
          restoreOverflowFocus={!search && !settings && !details}
          onSelect={select}
          onReorder={moveTab}
          onClose={close}
          onTrash={trash}
          onSearch={openSearch}
        />
      )}
      {focus && active && (
        <FloatingOverlay
          key={active.id}
          className="focus-controls"
          label="fullscreen controls"
          position={active.overlayPositions?.fullscreen}
          onPosition={(position) => updateOverlayPosition(active.id, "fullscreen", position)}
        >
          {hasModes ? (
            <NativeSelect
              size="sm"
              className="fullscreen-mode-select"
              ref={modeSelect}
              aria-label={html ? "Fullscreen HTML mode" : "Fullscreen diagram mode"}
              value={html && fullscreenMode === "edit" ? "view" : fullscreenMode}
              onChange={(event) => {
                if (event.target.value === "tabs") toggleFocus();
                else setFullscreenMode(event.target.value as FullscreenMode);
              }}
            >
              {!html && <NativeSelectOption value="edit">Edit</NativeSelectOption>}
              <NativeSelectOption value="view">View</NativeSelectOption>
              <NativeSelectOption value="present">Present</NativeSelectOption>
              <NativeSelectOption value="tabs">Back to tabs</NativeSelectOption>
            </NativeSelect>
          ) : (
            <Button
              variant="secondary"
              size="icon-xs"
              ref={controlsButton}
              aria-label="Exit focus mode"
              title="Exit fullscreen · Escape"
              onClick={toggleFocus}
            >
              <Minimize2 />
            </Button>
          )}
        </FloatingOverlay>
      )}
      {presentation && active && <PresentationPointer tabId={active.id} />}
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
        {paneTabs.map((tab) => {
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
              hidden={id !== workspace.selected}
            >
              <TabHost
                tab={tab}
                active={id === workspace.selected}
                artifact={artifact}
                router={events}
                updateState={updateState}
                updateOverlayPosition={updateOverlayPosition}
                theme={theme}
                focus={focus && id === workspace.selected}
                viewing={viewing && id === workspace.selected}
              />
            </div>
          );
        })}
        {!workspace.selected && (
          <div className="artifact-pane">
            <section className="empty-state">
              <h1>Things your agents leave for you</h1>
              <p>Open an artifact to inspect it.</p>
              {activeArtifacts.length ? (
                <div className="artifact-list">
                  {activeArtifacts
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
        artifacts={activeArtifacts}
        onOpenArtifact={open}
        onOpenSettings={openSettings}
        finalFocus={settings || details || transferOpen ? false : returnFocus}
        actions={[
          {
            id: "import-tab",
            title: "Import tab",
            keywords: "receive transfer link scope",
            icon: Download,
            onSelect: () => {
              setTransfer({ kind: "tab", url: "" });
              setSearch(false);
            },
          },
          {
            id: "settings",
            title: "Settings",
            keywords: "preferences",
            icon: Settings,
            shortcut: "⌘,",
            onSelect: () => openSettings(),
          },
          ...(active
            ? [
                {
                  id: "fullscreen",
                  title: focus ? "Exit fullscreen" : "Fullscreen",
                  keywords: "full screen focus expand",
                  icon: focus ? Minimize2 : Maximize2,
                  shortcut: "⌘⇧F",
                  pressed: focus,
                  onSelect: () => {
                    toggleFocus();
                    setSearch(false);
                  },
                },
              ]
            : []),
        ]}
        currentTab={
          active
            ? {
                title: activeArtifact?.title ?? active.title,
                actions: [
                  ...(activeArtifact &&
                  isTransferKind(activeArtifact.kind) &&
                  (active.type === "file" || active.type === "diagram")
                    ? [
                        {
                          id: "send-tab",
                          title: "Send tab",
                          keywords: "transfer share scope",
                          icon: Send,
                          onSelect: () => {
                            setTransfer({
                              kind: "send",
                              tabId: active.id,
                              title: activeArtifact.title,
                            });
                            setSearch(false);
                          },
                        },
                      ]
                    : []),
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
                    id: "permanent",
                    title: activePermanent ? "Make temporary" : "Keep permanently",
                    keywords: "retention bookmark permanent temporary",
                    icon: Bookmark,
                    pressed: activePermanent,
                    onSelect: () => void retention.setPermanent(active.id, !activePermanent),
                  },
                  {
                    id: "close",
                    title: "Move to Trashcan",
                    keywords: "close trash delete remove",
                    icon: Trash2,
                    shortcut: activePermanent ? undefined : "⌘W",
                    onSelect: () => {
                      setSearch(false);
                      void trash(active.id);
                    },
                  },
                ],
              }
            : undefined
        }
      />
      {transfer?.kind === "send" && (
        <SendTabDialog
          tabId={transfer.tabId}
          title={transfer.title}
          finalFocus={returnFocus}
          onClose={() => closeTransfer(transfer)}
          onPair={() => {
            closeTransfer(transfer);
            openSettings("Other Scopes");
          }}
        />
      )}
      {transfer?.kind === "tab" && (
        <ImportTabDialog
          key={transfer.url}
          initialUrl={transfer.url}
          finalFocus={returnFocus}
          onClose={() => closeTransfer(transfer)}
          onImported={openImported}
        />
      )}
      {transfer?.kind === "pair" && (
        <PairScopeDialog
          key={transfer.url}
          url={transfer.url}
          finalFocus={returnFocus}
          onClose={() => closeTransfer(transfer)}
        />
      )}
      <Dialog open={settings} onOpenChange={setSettings}>
        <SettingsDialog finalFocus={search ? false : returnFocus}>
          <SettingsViewPanel
            key={settingsQuery}
            initialQuery={settingsQuery}
            onSettingsChange={(value) => {
              setPreferences(value);
              setAppearance(value.appearance);
            }}
          />
        </SettingsDialog>
      </Dialog>
      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent finalFocus={search ? false : returnFocus}>
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
  return (
    <SettingsContext.Provider value={{ settings: preferences, openSettings }}>
      {content}
    </SettingsContext.Provider>
  );
}
