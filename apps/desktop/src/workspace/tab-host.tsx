import type { GuestCatalogView, GuestRecord } from "../guest/contract.ts";
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { OverlayName, OverlayPosition, Tab, TabState } from "./contract.ts";
import type { TabEventRouter } from "./events.ts";
import { beforeClose } from "./persistence.ts";
import { findPlugin, guestPlugin } from "../plugins/registry.renderer.ts";
import { validateTabState } from "../plugins/registry.ts";
import type { Theme } from "../renderer/appearance.ts";

class TabErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <p role="alert" className="empty-state">
          Could not open this tab. Its saved data is still available. Restart Scope to retry.
        </p>
      );
    return this.props.children;
  }
}

export function TabHost({
  tab,
  router,
  updateState,
  updateOverlayPosition,
  active,
  onClose,
  guest,
  guestOwner,
  guestAvailable,
  ...display
}: {
  tab: Tab;
  router: TabEventRouter;
  updateState: (id: string, state: TabState) => void;
  updateOverlayPosition: (
    id: string,
    name: OverlayName,
    position: OverlayPosition | undefined,
  ) => void;
  active: boolean;
  onClose: (id: string) => void;
  guest?: GuestRecord;
  guestOwner?: GuestCatalogView["owners"][number];
  guestAvailable?: boolean;
  artifact?: Artifact;
  theme: Theme;
  focus: boolean;
  viewing: boolean;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  const events = useMemo(() => router.forTab(tab.id), [router, tab.id, tab.groupId]);
  const [saves] = useState(() => new Set<() => void>());
  useEffect(
    () => () => {
      events.dispose();
      for (const remove of saves) remove();
      saves.clear();
    },
    [events, saves],
  );
  const content = useMemo(
    () =>
      guest
        ? {
            ownerDeviceId: guest.ownerDeviceId,
            sourceTabId: guest.source.sourceTabId,
            read: (artifact: Artifact) => window.scope.guestContent(tab.id, artifact.revision),
          }
        : undefined,
    [tab.id, guest?.ownerDeviceId, guest?.source.sourceTabId],
  );
  const plugin =
    tab.type === "guest" ? guestPlugin(guest?.source.kind ?? "") : findPlugin(tab.type);
  if (tab.type === "guest" && (!guestAvailable || !guest))
    return (
      <p role="status" className="empty-state">
        {guestOwner?.message ??
          `${guestOwner?.name ?? "The owner"} or this source tab is unavailable. Reconnect to read current content.`}
      </p>
    );
  if (tab.type === "guest" && (!plugin || guest?.source.version !== 1))
    return (
      <p role="status" className="empty-state">
        Update Scope to open shared {guest?.source.kind === "plan" ? "plans" : "folders"} from{" "}
        {guestOwner?.name ?? "the owner"}.
      </p>
    );
  if (["file", "retro", "sketchpad", "folder", "guest"].includes(tab.type) && !active && !visited)
    return null;
  if (!plugin)
    return (
      <p role="status" className="empty-state">
        This tab type is unavailable. Its saved data is still available.
      </p>
    );
  try {
    validateTabState(tab);
  } catch {
    return (
      <p role="alert" className="empty-state">
        This tab's saved state cannot be opened by this version of Scope.
      </p>
    );
  }
  const View = plugin.View;
  return (
    <TabErrorBoundary key={tab.type}>
      <Suspense
        fallback={
          <p className="empty-state" role="status">
            Opening tab…
          </p>
        }
      >
        <View
          tab={tab}
          active={active}
          {...display}
          artifact={guest?.source.artifact ?? display.artifact}
          context={{
            content,
            tabId: tab.id,
            groupId: tab.groupId,
            events,
            updateState: (state) => updateState(tab.id, state),
            close: () => onClose(tab.id),
            updateOverlayPosition: (name, position) =>
              updateOverlayPosition(tab.id, name, position),
            onBeforeClose: (save) => {
              const remove = beforeClose(save, tab.id);
              saves.add(remove);
              return () => {
                remove();
                saves.delete(remove);
              };
            },
          }}
        />
      </Suspense>
    </TabErrorBoundary>
  );
}
