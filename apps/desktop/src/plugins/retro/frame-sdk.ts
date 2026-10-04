export type RetroFrameIdentity = { channel: string; tabId: string };

function installRetroSDK(identity: RetroFrameIdentity) {
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      promise: Promise<unknown>;
      write: boolean;
    }
  >();
  const watchers = new Set<(snapshot: unknown) => void>();
  const closing = new Set<() => Promise<void>>();
  let latest: { version: number } | undefined;
  function freeze(value: unknown): unknown {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  function send(method: string, args: unknown[], write = false) {
    const id = crypto.randomUUID();
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending.set(id, { resolve, reject, promise, write });
    try {
      parent.postMessage({ ...identity, type: "scope-retro-call", id, method, args }, "*");
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("Could not send this report edit."));
    }
    return promise;
  }
  async function waitForWrites() {
    while ([...pending.values()].some((call) => call.write))
      await Promise.all(
        [...pending.values()].filter((call) => call.write).map((call) => call.promise),
      );
  }
  async function flush(id: string) {
    let error: string | undefined;
    try {
      await waitForWrites();
      for (const callback of closing) await callback();
      await waitForWrites();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "Could not save report edits.";
    }
    parent.postMessage({ ...identity, type: "scope-retro-flushed", id, error }, "*");
  }
  addEventListener("message", (event) => {
    const value = event.data;
    if (
      event.source !== parent ||
      value?.channel !== identity.channel ||
      value?.tabId !== identity.tabId
    )
      return;
    if (value.type === "scope-retro-close") void flush(value.id);
    if (value.type === "scope-retro-snapshot" && value.value.version >= (latest?.version ?? -1)) {
      latest = freeze(value.value) as typeof latest;
      for (const watcher of watchers) {
        try {
          watcher(latest);
        } catch (error) {
          console.error(error);
        }
      }
    }
    if (value.type === "scope-retro-reply") {
      const call = pending.get(value.id);
      if (!call) return;
      pending.delete(value.id);
      if (value.error)
        call.reject(
          Object.assign(new Error(value.error.message ?? value.error), { code: value.error.code }),
        );
      else call.resolve(freeze(value.value));
    }
  });
  const retros = Object.freeze({
    watch(callback: (snapshot: unknown) => void) {
      watchers.add(callback);
      if (latest) callback(latest);
      return () => {
        watchers.delete(callback);
      };
    },
    decide: (findingId: string, decision: unknown, expectedVersion: number) =>
      send("decide", [findingId, decision, expectedVersion], true),
    comment: (findingId: string | null, text: string, expectedVersion: number) =>
      send("comment", [findingId, text, expectedVersion], true),
    request: (findingId: string | null, text: string, expectedVersion: number) =>
      send("request", [findingId, text, expectedVersion], true),
    state: Object.freeze({
      read: () => send("readState", []),
      patch: (value: Record<string, unknown>, expectedVersion: number) =>
        send("patchState", [value, expectedVersion], true),
    }),
    history: Object.freeze({
      list: (after?: string) => send("history", [after]),
      open: (retroId: string) => send("openHistory", [retroId]),
    }),
    beforeClose(callback: () => Promise<void>) {
      closing.add(callback);
      return () => {
        closing.delete(callback);
      };
    },
  });
  Object.defineProperty(window, "scope", {
    value: Object.freeze({ retros }),
    configurable: false,
    writable: false,
  });
  parent.postMessage({ ...identity, type: "scope-retro-ready" }, "*");
}

export function retroDocument(html: string, identity: RetroFrameIdentity): string {
  const script = `<script>(${installRetroSDK.toString()})(${JSON.stringify(identity).replace(/</g, "\\u003c")})</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const offset = doctype ? doctype[0].length : 0;
  return html.slice(0, offset) + script + html.slice(offset);
}
