export type FrameIdentity = { channel: string; tabId: string };

export type WindowContext = {
  id: string;
  openerId: string | null;
  context: unknown;
};

function installWorkspaceSDK(identity: FrameIdentity, windowContext: WindowContext) {
  type AppState = { version: number; value: Readonly<Record<string, unknown>> };
  type StateUpdate = AppState & { operation: "snapshot" | "set" | "patch" | "delete" };
  type SnapshotPayload = {
    milestones: readonly unknown[];
    issues: readonly unknown[];
    pullRequests: readonly unknown[];
    board: unknown;
    transitions: readonly unknown[];
    appState?: AppState;
    context: unknown;
    sync: unknown;
  };
  type Watcher = (data: SnapshotPayload) => void;
  type NodeStateEntry = {
    state?: AppState;
    watchers: Set<(update: StateUpdate) => void>;
    reading?: Promise<unknown>;
    revision: number;
    notice?: { version: number; operation: StateUpdate["operation"] };
  };

  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      promise: Promise<unknown>;
      method: string;
      args: unknown[];
      nodeEntry?: NodeStateEntry;
    }
  >();
  const watchers = new Set<Watcher>();
  const stateWatchers = new Set<(update: StateUpdate) => void>();
  const nodeStates = new Map<string, NodeStateEntry>();
  const closing = new Set<() => Promise<void>>();
  const messages = new Set<(message: unknown) => void>();
  let appState: AppState | undefined;
  let latest: SnapshotPayload | undefined;
  let generation = -1;

  function freeze(value: unknown): unknown {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  function stateUpdate(update: StateUpdate) {
    if (update.version <= (appState?.version ?? -1)) return;
    appState = freeze({ version: update.version, value: update.value }) as AppState;
    const frozen = freeze(update) as StateUpdate;
    for (const watcher of stateWatchers) {
      try {
        watcher(frozen);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function nodeEntry(nodeId: string): NodeStateEntry {
    let entry = nodeStates.get(nodeId);
    if (!entry) {
      entry = { watchers: new Set(), revision: 0 };
      nodeStates.set(nodeId, entry);
    }
    return entry;
  }

  function nodeStateUpdate(entry: NodeStateEntry, update: StateUpdate) {
    if (update.version <= (entry.state?.version ?? -1)) return;
    entry.state = freeze({ version: update.version, value: update.value }) as AppState;
    const frozen = freeze(update) as StateUpdate;
    for (const watcher of entry.watchers) {
      try {
        watcher(frozen);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function refreshNodeState(nodeId: string, notice?: NodeStateEntry["notice"]) {
    const entry = nodeEntry(nodeId);
    entry.revision++;
    entry.notice = notice;
    if (entry.reading) return;
    entry.reading = (async () => {
      let read: number;
      do {
        read = entry.revision;
        const captured = entry.notice;
        try {
          const state = (await send("readNodeState", [nodeId])) as AppState;
          if (nodeStates.get(nodeId) !== entry) return;
          nodeStateUpdate(entry, {
            ...state,
            operation: captured?.version === state.version ? captured.operation : "snapshot",
          });
        } catch (error) {
          console.error(error);
        }
      } while (nodeStates.get(nodeId) === entry && entry.watchers.size && read !== entry.revision);
    })().finally(() => {
      entry.reading = undefined;
    });
  }

  function send(method: string, args: unknown[]) {
    const id = crypto.randomUUID();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.set(id, {
      resolve,
      reject,
      promise,
      method,
      args,
      ...(method.endsWith("NodeState") ? { nodeEntry: nodeEntry(args[0] as string) } : {}),
    });
    try {
      parent.postMessage({ ...identity, type: "scope-workspace-call", id, method, args }, "*");
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("Could not send the operation."));
    }
    return promise;
  }

  function waitForWrites() {
    return Promise.all(
      [...pending.values()]
        .filter((call) =>
          [
            "saveNote",
            "setSnooze",
            "inspect",
            "markReviewed",
            "setState",
            "patchState",
            "deleteState",
            "setNodeState",
            "patchNodeState",
            "deleteNodeState",
          ].includes(call.method),
        )
        .map((call) => call.promise),
    );
  }

  async function flush(id: string) {
    let error: string | undefined;
    try {
      await waitForWrites();
      await Promise.all([...closing].map((callback) => callback()));
      await waitForWrites();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "Could not save workspace edits.";
    }
    parent.postMessage({ ...identity, type: "scope-workspace-flushed", id, error }, "*");
  }

  addEventListener("message", (event) => {
    const value = event.data;
    if (
      event.source !== parent ||
      value?.channel !== identity.channel ||
      value?.tabId !== identity.tabId
    )
      return;
    if (value.type === "scope-workspace-state") stateUpdate(value.value);
    if (value.type === "scope-workspace-node-state-change") {
      const entry = nodeStates.get(value.value.nodeId);
      if (entry?.watchers.size && value.value.version > (entry.state?.version ?? -1))
        refreshNodeState(value.value.nodeId, value.value);
    }
    if (value.type === "scope-workspace-node-state-refresh") {
      for (const [nodeId, entry] of nodeStates) {
        nodeStates.set(nodeId, { watchers: entry.watchers, revision: 0 });
        if (entry.watchers.size) refreshNodeState(nodeId);
      }
    }
    if (value.type === "scope-workspace-close") void flush(value.id);
    if (value.type === "scope-window-message") {
      const message = freeze(value.value);
      for (const watcher of messages) {
        try {
          watcher(message);
        } catch (error) {
          console.error(error);
        }
      }
    }
    if (value.type === "scope-workspace-link-result" && value.error) {
      dispatchEvent(
        new CustomEvent("scope-workspace-external-error", {
          detail: { url: value.url, message: value.error },
        }),
      );
    }
    if (value.type === "scope-workspace-snapshot" && value.generation >= generation) {
      generation = value.generation;
      latest = freeze(value.value) as SnapshotPayload;
      stateUpdate({
        ...(value.value.appState ?? { version: 0, value: {} }),
        operation: "snapshot",
      });
      for (const watcher of watchers) {
        try {
          watcher(latest);
        } catch (error) {
          console.error(error);
        }
      }
    }
    if (value.type === "scope-workspace-reply") {
      const call = pending.get(value.id);
      if (!call) return;
      pending.delete(value.id);
      if (value.error) call.reject(new Error(value.error));
      else {
        if (call.nodeEntry && call.method !== "readNodeState") {
          nodeStateUpdate(call.nodeEntry, {
            ...value.value,
            operation:
              call.method === "setNodeState"
                ? "set"
                : call.method === "patchNodeState"
                  ? "patch"
                  : "delete",
          });
        }
        call.resolve(call.method.includes("State") ? freeze(value.value) : value.value);
      }
    }
  });

  function stateForNode(nodeId: string) {
    return Object.freeze({
      read: () => send("readNodeState", [nodeId]),
      set: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
        send("setNodeState", [nodeId, value, expectedVersion]),
      patch: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
        send("patchNodeState", [nodeId, value, expectedVersion]),
      delete: (keys: readonly string[], expectedVersion: number) =>
        send("deleteNodeState", [nodeId, keys, expectedVersion]),
      watch(watcher: (update: StateUpdate) => void) {
        const entry = nodeEntry(nodeId);
        entry.watchers.add(watcher);
        if (entry.state) watcher(freeze({ ...entry.state, operation: "snapshot" }) as StateUpdate);
        refreshNodeState(nodeId);
        return () => {
          entry.watchers.delete(watcher);
        };
      },
    });
  }

  const state = Object.freeze({
    forNode: stateForNode,
    read: () => send("readState", []),
    set: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
      send("setState", [value, expectedVersion]),
    patch: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
      send("patchState", [value, expectedVersion]),
    delete: (keys: readonly string[], expectedVersion: number) =>
      send("deleteState", [keys, expectedVersion]),
    watch(watcher: (update: StateUpdate) => void) {
      stateWatchers.add(watcher);
      if (appState) watcher(freeze({ ...appState, operation: "snapshot" }) as StateUpdate);
      return () => stateWatchers.delete(watcher);
    },
  });

  const sdk = Object.freeze({
    state,
    openExternal: (url: string) => send("openExternal", [url]),
    configure: (config: {
      repository: { owner: string; name: string };
      board?: { owner: string; ownerType: "organization" | "user"; number: number } | null;
    }) => send("configure", [config]),
    sync: () => send("sync", []),
    prDetail: (nodeId: string, captured?: { headOid: string; baseOid: string }) =>
      send("prDetail", [nodeId, captured]),
    loadPrDetails: (nodeIds: readonly string[]) => send("loadPrDetails", [nodeIds]),
    issueDetail: (nodeId: string) => send("issueDetail", [nodeId]),
    saveNote: (nodeId: string, note: string, expectedVersion: number) =>
      send("saveNote", [nodeId, note, expectedVersion]),
    setSnooze: (nodeId: string, snooze: unknown, expectedVersion: number) =>
      send("setSnooze", [nodeId, snooze, expectedVersion]),
    markReviewed: (nodeId: string, headCommit: string, expectedVersion: number) =>
      send("markReviewed", [nodeId, headCommit, expectedVersion]),
    inspect: (nodeId: string, headCommit: string, expectedVersion: number) =>
      send("inspect", [nodeId, headCommit, expectedVersion]),
    watch(watcher: Watcher) {
      watchers.add(watcher);
      if (latest) watcher(latest);
      return () => watchers.delete(watcher);
    },
    beforeClose(callback: () => Promise<void>) {
      closing.add(callback);
      return () => closing.delete(callback);
    },
  });

  const windows = Object.freeze({
    open: (content: { title: string; html: string; context?: unknown }) =>
      send("openWindow", [content]),
    close: (id: string = windowContext.id) => send("closeWindow", [id]),
    broadcast: (value: unknown) => send("broadcast", [value]),
    watch(watcher: (message: unknown) => void) {
      messages.add(watcher);
      return () => messages.delete(watcher);
    },
  });

  Object.defineProperty(window, "scope", {
    value: Object.freeze({ workspace: sdk, windows, window: freeze(windowContext) }),
  });

  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || windowContext.openerId === null) return;
    setTimeout(() => {
      if (!event.defaultPrevented && document.hasFocus()) {
        event.preventDefault();
        void windows.close().catch((error: Error) => console.error(error));
      }
    }, 0);
  });

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (url !== undefined) {
      try {
        const parsed = new URL(String(url), document.baseURI);
        if (["http:", "https:"].includes(parsed.protocol)) {
          void sdk.openExternal(parsed.href).catch(() => {});
          return null;
        }
      } catch {
        // Fall through to original open.
      }
    }
    return originalOpen(url, target, features);
  };

  addEventListener("focus", () =>
    parent.postMessage({ ...identity, type: "scope-window-focus" }, "*"),
  );
  parent.postMessage({ ...identity, type: "scope-workspace-ready" }, "*");
}

export function workspaceDocument(
  html: string,
  identity: FrameIdentity,
  context: WindowContext = { id: "main", openerId: null, context: null },
): string {
  const script = `<script>(${installWorkspaceSDK.toString()})(${JSON.stringify(identity).replaceAll("<", "\\u003c")},${JSON.stringify(context).replaceAll("<", "\\u003c")});</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i;
  return doctype.test(html)
    ? html.replace(doctype, (value) => `${value}${script}`)
    : `${script}${html}`;
}
