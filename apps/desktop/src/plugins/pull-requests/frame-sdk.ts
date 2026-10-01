export type FrameIdentity = { channel: string; tabId: string };

function installPullRequestsSDK(identity: FrameIdentity) {
  type Watcher = (pullRequests: readonly unknown[], context: unknown, sync: unknown) => void;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      promise: Promise<unknown>;
      method: string;
    }
  >();
  const watchers = new Set<Watcher>();
  const closing = new Set<() => Promise<void>>();
  let latest: { pullRequests: readonly unknown[]; context: unknown; sync: unknown } | undefined;
  let generation = -1;
  function send(method: string, args: unknown[]) {
    const id = crypto.randomUUID();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.set(id, { resolve, reject, promise, method });
    parent.postMessage({ ...identity, type: "scope-pull-requests-call", id, method, args }, "*");
    return promise;
  }
  async function flush(id: string) {
    let error: string | undefined;
    try {
      await Promise.all([...closing].map((callback) => callback()));
      await Promise.all(
        [...pending.values()]
          .filter((call) => !["sync", "detail"].includes(call.method))
          .map((call) => call.promise),
      );
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
  addEventListener("message", (event) => {
    const value = event.data;
    if (
      event.source !== parent ||
      value?.channel !== identity.channel ||
      value?.tabId !== identity.tabId
    )
      return;
    if (value.type === "scope-pull-requests-close") void flush(value.id);
    if (value.type === "scope-pull-requests-snapshot" && value.generation >= generation) {
      generation = value.generation;
      latest = freeze(value.value) as typeof latest;
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
      else call.resolve(value.value);
    }
  });
  const sdk = Object.freeze({
    watch(watcher: Watcher) {
      watchers.add(watcher);
      if (latest) watcher(latest.pullRequests, latest.context, latest.sync);
      return () => watchers.delete(watcher);
    },
    beforeClose(callback: () => Promise<void>) {
      closing.add(callback);
      return () => closing.delete(callback);
    },
    sync: () => send("sync", []),
    saveNote: (pullRequestId: string, note: string) => send("saveNote", [pullRequestId, note]),
    setSnooze: (pullRequestId: string, snooze: unknown) =>
      send("setSnooze", [pullRequestId, snooze]),
    markReviewed: (pullRequestId: string, headCommit: string) =>
      send("markReviewed", [pullRequestId, headCommit]),
    inspect: (pullRequestId: string, headCommit: string) =>
      send("inspect", [pullRequestId, headCommit]),
    detail: (pullRequestId: string, section: string) => send("detail", [pullRequestId, section]),
  });
  Object.defineProperty(window, "scope", { value: Object.freeze({ pullRequests: sdk }) });
  parent.postMessage({ ...identity, type: "scope-pull-requests-ready" }, "*");
}

export function pullRequestsDocument(html: string, identity: FrameIdentity): string {
  const script = `<script>(${installPullRequestsSDK.toString()})(${JSON.stringify(identity).replaceAll("<", "\\u003c")});</script>`;
  // Insertion before the authored document also covers scripts before its head tag.
  const doctype = /^\s*<!doctype[^>]*>/i;
  return doctype.test(html)
    ? html.replace(doctype, (value) => `${value}${script}`)
    : `${script}${html}`;
}
