import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { Tab, TabState } from "./contract.ts";
import type { TabEventRouter } from "./events.ts";
import { beforeClose } from "./persistence.ts";
import { findPlugin } from "../plugins/registry.renderer.ts";
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
  ...display
}: {
  tab: Tab;
  router: TabEventRouter;
  updateState: (id: string, state: TabState) => void;
  artifact?: Artifact;
  theme: Theme;
  focus: boolean;
}) {
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
  const plugin = findPlugin(tab.type);
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
          {...display}
          context={{
            tabId: tab.id,
            groupId: tab.groupId,
            events,
            updateState: (state) => updateState(tab.id, state),
            onBeforeClose: (save) => {
              const remove = beforeClose(save);
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
