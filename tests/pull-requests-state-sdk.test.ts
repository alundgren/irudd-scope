import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { pullRequestsDocument } from "../apps/desktop/src/plugins/pull-requests/frame-sdk.ts";

type State = { version: number; value: Record<string, unknown> };
type Call = { type: string; id: string; method: string };
type SDK = {
  state: {
    forPR: (nodeId: string) => {
      read: () => Promise<State>;
      set: (value: Record<string, unknown>, version: number) => Promise<State>;
      watch: (callback: (state: State) => void) => () => void;
    };
  };
};

function sdkFixture() {
  const identity = { channel: randomUUID(), tabId: randomUUID() };
  const calls: Call[] = [];
  let receive!: (event: unknown) => void;
  const parent = { postMessage: (value: Call) => calls.push(value) };
  const window = { open: () => null };
  const context = createContext({
    window,
    parent,
    crypto: { randomUUID },
    console,
    addEventListener: (name: string, callback: typeof receive) => {
      if (name === "message") receive = callback;
    },
  });
  const document = pullRequestsDocument("<!doctype html>", identity);
  runInContext(
    document.slice(document.indexOf("<script>") + 8, document.indexOf("</script>")),
    context,
  );
  const sdk = (window as unknown as { scope: { pullRequests: SDK } }).scope.pullRequests;
  const send = (value: unknown) =>
    receive({ source: parent, data: { ...identity, ...(value as object) } });
  let generation = 0;
  return {
    sdk,
    snapshot: (present = true) =>
      send({
        type: "scope-pull-requests-snapshot",
        generation: ++generation,
        value: { pullRequests: present ? [{ nodeId: "PR_1" }] : [], context: {}, sync: {} },
      }),
    lastCall: () => calls.filter((call) => call.type === "scope-pull-requests-call").at(-1)!,
    reply: (call: Call, state: State) =>
      send({ type: "scope-pull-requests-reply", id: call.id, value: state }),
    reconnect: () => send({ type: "scope-pull-request-state-refresh" }),
  };
}

test.each(["read", "first write"])(
  "a delayed %s cannot return removed PR state",
  async (method) => {
    const f = sdkFixture();
    f.snapshot();
    const state = f.sdk.state.forPR("PR_1");
    const result = (method === "read" ? state.read() : state.set({ changed: true }, 0)).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const call = f.lastCall();
    f.snapshot(false);
    f.reply(call, { version: 3, value: { removedPR: true } });
    expect(await result).toContain("removed while loading state");
    f.snapshot();
    const updates: State[] = [];
    const stop = state.watch((update) => updates.push(update));
    f.reply(f.lastCall(), { version: 0, value: {} });
    await expect.poll(() => updates).toEqual([{ operation: "snapshot", version: 0, value: {} }]);
    stop();
  },
);

test("reconnect replaces cached state after a missed PR removal and reappearance", async () => {
  const f = sdkFixture();
  f.snapshot();
  const updates: State[] = [];
  const stop = f.sdk.state.forPR("PR_1").watch((update) => updates.push(update));
  f.reply(f.lastCall(), { version: 3, value: { oldPR: true } });
  await expect.poll(() => updates.length).toBe(1);
  // The final inventory still contains the node; its intervening absence was missed.
  f.snapshot();
  f.reconnect();
  f.reply(f.lastCall(), { version: 0, value: {} });
  await expect
    .poll(() => updates)
    .toEqual([
      { operation: "snapshot", version: 3, value: { oldPR: true } },
      { operation: "snapshot", version: 0, value: {} },
    ]);
  stop();
});
