export type FrameIdentity = { channel: string; tabId: string };

export type WindowContext = {
  id: string;
  openerId: string | null;
  context: unknown;
};

function installPullRequestsSDK(identity: FrameIdentity, windowContext: WindowContext) {
  type Watcher = (pullRequests: readonly unknown[], context: unknown, sync: unknown) => void;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      promise: Promise<unknown>;
      method: string;
      args: unknown[];
      stateEntry?: PrStateEntry;
    }
  >();
  const watchers = new Set<Watcher>();
  const detailWatchers = new Set<{
    nodeId: string;
    headOid: string;
    baseOid: string;
    watcher: (update: unknown) => void;
  }>();
  type AppState = { version: number; value: Readonly<Record<string, unknown>> };
  type StateUpdate = AppState & { operation: "snapshot" | "set" | "patch" | "delete" };
  const stateWatchers = new Set<(update: StateUpdate) => void>();
  let appState: AppState | undefined;
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
  type PrStateEntry = {
    state?: AppState;
    watchers: Set<(update: StateUpdate) => void>;
    reading?: Promise<unknown>;
    revision: number;
    notice?: { version: number; operation: StateUpdate["operation"] };
  };
  const prStates = new Map<string, PrStateEntry>();
  function prEntry(nodeId: string): PrStateEntry {
    let entry = prStates.get(nodeId);
    if (!entry) {
      entry = { watchers: new Set(), revision: 0 };
      prStates.set(nodeId, entry);
    }
    return entry;
  }
  function prStateUpdate(entry: PrStateEntry, update: StateUpdate) {
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
  function refreshPrState(nodeId: string, notice?: PrStateEntry["notice"]) {
    const entry = prEntry(nodeId);
    entry.revision++;
    entry.notice = notice;
    if (entry.reading) return;
    entry.reading = (async () => {
      let read: number;
      do {
        read = entry.revision;
        const captured = entry.notice;
        try {
          const state = (await send("readPrState", [nodeId])) as AppState;
          if (prStates.get(nodeId) !== entry) return;
          prStateUpdate(entry, {
            ...state,
            operation: captured?.version === state.version ? captured.operation : "snapshot",
          });
        } catch (error) {
          console.error(error);
        }
      } while (prStates.get(nodeId) === entry && entry.watchers.size && read !== entry.revision);
    })().finally(() => {
      entry.reading = undefined;
    });
  }
  function stateForPR(nodeId: string) {
    return Object.freeze({
      read: () => send("readPrState", [nodeId]),
      set: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
        send("setPrState", [nodeId, value, expectedVersion]),
      patch: (value: Readonly<Record<string, unknown>>, expectedVersion: number) =>
        send("patchPrState", [nodeId, value, expectedVersion]),
      delete: (keys: readonly string[], expectedVersion: number) =>
        send("deletePrState", [nodeId, keys, expectedVersion]),
      watch(watcher: (update: StateUpdate) => void) {
        const entry = prEntry(nodeId);
        entry.watchers.add(watcher);
        if (entry.state) watcher(freeze({ ...entry.state, operation: "snapshot" }) as StateUpdate);
        if (!latest || latest.pullRequests.some((pr) => pr.nodeId === nodeId))
          refreshPrState(nodeId);
        return () => {
          entry.watchers.delete(watcher);
        };
      },
    });
  }
  const closing = new Set<() => Promise<void>>();
  const messages = new Set<(message: unknown) => void>();
  let latest:
    | { pullRequests: readonly { nodeId: string }[]; context: unknown; sync: unknown }
    | undefined;
  let generation = -1;
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
      ...(method.endsWith("PrState") ? { stateEntry: prEntry(args[0] as string) } : {}),
    });
    try {
      parent.postMessage({ ...identity, type: "scope-pull-requests-call", id, method, args }, "*");
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
            "setPrState",
            "patchPrState",
            "deletePrState",
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
      error = failure instanceof Error ? failure.message : "Could not save inbox edits.";
    }
    parent.postMessage({ ...identity, type: "scope-pull-requests-flushed", id, error }, "*");
  }
  function freeze(value: unknown): unknown {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function reportDetailInterest() {
    parent.postMessage(
      {
        ...identity,
        type: "scope-pull-requests-interest",
        details: [...detailWatchers].map(({ nodeId, headOid, baseOid }) => ({
          nodeId,
          headOid,
          baseOid,
        })),
      },
      "*",
    );
  }
  addEventListener("message", (event) => {
    const value = event.data;
    if (
      event.source !== parent ||
      value?.channel !== identity.channel ||
      value?.tabId !== identity.tabId
    )
      return;
    if (value.type === "scope-pull-requests-state") stateUpdate(value.value);
    if (value.type === "scope-pull-request-state-change") {
      const entry = prStates.get(value.value.nodeId);
      if (entry?.watchers.size && value.value.version > (entry.state?.version ?? -1))
        refreshPrState(value.value.nodeId, value.value);
    }
    if (value.type === "scope-pull-request-state-refresh") {
      for (const [nodeId, entry] of prStates) {
        // A missed removal and reappearance resets the persisted version to zero.
        prStates.set(nodeId, { watchers: entry.watchers, revision: 0 });
        if (entry.watchers.size && latest?.pullRequests.some((pr) => pr.nodeId === nodeId))
          refreshPrState(nodeId);
      }
    }
    if (value.type === "scope-pull-requests-close") void flush(value.id);
    if (value.type === "scope-pull-requests-detail-update") {
      const update = freeze(value.value);
      for (const subscription of detailWatchers) {
        if (
          value.value?.nodeId !== subscription.nodeId ||
          value.value?.headOid !== subscription.headOid ||
          value.value?.baseOid !== subscription.baseOid
        )
          continue;
        try {
          subscription.watcher(update);
        } catch (error) {
          console.error(error);
        }
      }
    }
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
    if (value.type === "scope-pull-requests-link-result" && value.error)
      reportExternalError(value.url, value.error);
    if (value.type === "scope-pull-requests-snapshot" && value.generation >= generation) {
      generation = value.generation;
      const ids = new Set(value.value.pullRequests.map((pr: { nodeId: string }) => pr.nodeId));
      for (const [nodeId, entry] of prStates) {
        if (!ids.has(nodeId)) {
          // Retain subscriptions, but discard values and detach any in-flight reply from the removed PR.
          prStates.set(nodeId, { watchers: entry.watchers, revision: 0 });
        } else if (!entry.state && entry.watchers.size && !entry.reading) refreshPrState(nodeId);
      }
      latest = freeze(value.value) as typeof latest;
      stateUpdate({
        ...(value.value.appState ?? { version: 0, value: {} }),
        operation: "snapshot",
      });
      for (const watcher of watchers) {
        try {
          watcher(latest!.pullRequests, latest!.context, latest!.sync);
        } catch (error) {
          console.error(error);
        }
      }
    }
    if (value.type === "scope-pull-requests-reply") {
      const call = pending.get(value.id);
      if (!call) return;
      pending.delete(value.id);
      if (value.error) call.reject(new Error(value.error));
      else if (call.stateEntry && prStates.get(call.args[0] as string) !== call.stateEntry)
        call.reject(
          new Error("This pull request was removed while loading state. Refresh the inbox."),
        );
      else {
        if (
          call.stateEntry &&
          prStates.get(call.args[0] as string) === call.stateEntry &&
          call.method !== "readPrState"
        )
          prStateUpdate(call.stateEntry, {
            ...value.value,
            operation:
              call.method === "setPrState"
                ? "set"
                : call.method === "patchPrState"
                  ? "patch"
                  : "delete",
          });
        call.resolve(
          [
            "readState",
            "setState",
            "patchState",
            "deleteState",
            "readPrState",
            "setPrState",
            "patchPrState",
            "deletePrState",
          ].includes(call.method)
            ? freeze(value.value)
            : value.value,
        );
      }
    }
  });
  const state = Object.freeze({
    forPR: stateForPR,
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
    loadDetails: (nodeIds: readonly string[]) => send("loadDetails", [nodeIds]),
    watch(watcher: Watcher) {
      watchers.add(watcher);
      if (latest) watcher(latest.pullRequests, latest.context, latest.sync);
      return () => watchers.delete(watcher);
    },
    watchDetail(
      nodeId: string,
      headOid: string,
      baseOid: string,
      watcher: (update: unknown) => void,
    ) {
      const subscription = { nodeId, headOid, baseOid, watcher };
      detailWatchers.add(subscription);
      reportDetailInterest();
      return () => {
        detailWatchers.delete(subscription);
        reportDetailInterest();
      };
    },
    beforeClose(callback: () => Promise<void>) {
      closing.add(callback);
      return () => closing.delete(callback);
    },
    sync: () => send("sync", []),
    saveNote: (pullRequestId: string, note: string, expectedVersion: number) =>
      send("saveNote", [pullRequestId, note, expectedVersion]),
    setSnooze: (pullRequestId: string, snooze: unknown, expectedVersion: number) =>
      send("setSnooze", [pullRequestId, snooze, expectedVersion]),
    markReviewed: (pullRequestId: string, headCommit: string, expectedVersion: number) =>
      send("markReviewed", [pullRequestId, headCommit, expectedVersion]),
    inspect: (pullRequestId: string, headCommit: string, expectedVersion: number) =>
      send("inspect", [pullRequestId, headCommit, expectedVersion]),
    detail: (
      pullRequestId: string,
      section: string,
      captured?: { headOid: string; baseOid: string },
    ) => send("detail", [pullRequestId, section, captured]),
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
    value: Object.freeze({ pullRequests: sdk, windows, window: freeze(windowContext) }),
  });
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || windowContext.openerId === null) return;
    // Authored handlers run first and can keep Escape for their own interaction.
    setTimeout(() => {
      if (!event.defaultPrevented && document.hasFocus()) {
        event.preventDefault();
        void windows.close().catch((error: Error) => console.error(error));
      }
    }, 0);
  });
  function externalURL(value: string): string | undefined {
    try {
      const url = new URL(value, document.baseURI);
      if (!["http:", "https:"].includes(url.protocol)) return;
      return url.href;
    } catch {
      return;
    }
  }
  function reportExternalError(url: string, message: string) {
    dispatchEvent(
      new CustomEvent("scope-pull-requests-external-error", { detail: { url, message } }),
    );
  }
  function openLink(url: string) {
    void sdk.openExternal(url).catch((error: Error) => reportExternalError(url, error.message));
  }
  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    const external = url === undefined ? undefined : externalURL(String(url));
    if (!external) return originalOpen(url, target, features);
    openLink(external);
    return null;
  };
  addEventListener("focus", () =>
    parent.postMessage({ ...identity, type: "scope-window-focus" }, "*"),
  );
  parent.postMessage({ ...identity, type: "scope-pull-requests-ready" }, "*");
}

export function pullRequestsDocument(
  html: string,
  identity: FrameIdentity,
  context: WindowContext = { id: "main", openerId: null, context: null },
): string {
  const script = `<script>(${installPullRequestsSDK.toString()})(${JSON.stringify(identity).replaceAll("<", "\\u003c")},${JSON.stringify(context).replaceAll("<", "\\u003c")});</script>`;
  // Insertion before the authored document also covers scripts before its head tag.
  const doctype = /^\s*<!doctype[^>]*>/i;
  return doctype.test(html)
    ? html.replace(doctype, (value) => `${value}${script}`)
    : `${script}${html}`;
}
