import { expect, test } from "vite-plus/test";
import { createContext, runInContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { retroDocument } from "../apps/desktop/src/plugins/retro/frame-sdk.ts";

type Call = { type: string; id: string; method: string; error?: string };
function fixture() {
  const identity = { channel: randomUUID(), tabId: randomUUID() };
  const calls: Call[] = [];
  const parent = { postMessage: (value: Call) => calls.push(value) };
  const window = {};
  let receive!: (event: unknown) => void;
  const document = retroDocument(
    "<!doctype html><script>authored()</script><html><head></head></html>",
    identity,
  );
  runInContext(
    document.slice(document.indexOf("<script>") + 8, document.indexOf("</script>")),
    createContext({
      window,
      parent,
      crypto: { randomUUID },
      console,
      addEventListener: (_: string, callback: typeof receive) => {
        receive = callback;
      },
    }),
  );
  const sdk = (
    window as unknown as {
      scope: {
        retros: {
          watch: (
            callback: (snapshot: { version: number; data: { note: string } }) => void,
          ) => () => void;
          comment: (id: string, text: string, version: number) => Promise<unknown>;
          state: { patch: (value: Record<string, unknown>, version: number) => Promise<unknown> };
          beforeClose: (callback: () => Promise<void>) => () => void;
        };
      };
    }
  ).scope.retros;
  const send = (value: unknown) =>
    receive({ source: parent, data: { ...identity, ...(value as object) } });
  return { sdk, calls, send, document };
}

test("RETRO SDK exists before authored scripts and exposes immutable snapshots", () => {
  const f = fixture();
  expect(f.document.indexOf("Object.defineProperty")).toBeLessThan(
    f.document.indexOf("authored()"),
  );
  let snapshot: unknown;
  f.sdk.watch((value) => {
    snapshot = value;
  });
  f.send({ type: "scope-retro-snapshot", value: { version: 2, data: { note: "Saved" } } });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen((snapshot as { data: unknown }).data)).toBe(true);
  f.send({ type: "scope-retro-snapshot", value: { version: 1, data: { note: "Stale" } } });
  expect(snapshot).toEqual({ version: 2, data: { note: "Saved" } });
  expect("finish" in f.sdk).toBe(false);
  expect("execute" in f.sdk).toBe(false);
});

test("leaving a report waits for writes made by its save callback", async () => {
  const f = fixture();
  f.sdk.beforeClose(async () => {
    await f.sdk.state.patch({ draft: "Keep my note" }, 0);
  });
  f.send({ type: "scope-retro-close", id: "closing" });
  await expect.poll(() => f.calls.some((call) => call.method === "patchState")).toBe(true);
  expect(f.calls.some((call) => call.type === "scope-retro-flushed")).toBe(false);
  const call = f.calls.find((call) => call.method === "patchState")!;
  f.send({ type: "scope-retro-reply", id: call.id, value: { version: 1 } });
  await expect
    .poll(() => f.calls.find((call) => call.type === "scope-retro-flushed"))
    .toEqual({
      channel: expect.any(String),
      tabId: expect.any(String),
      type: "scope-retro-flushed",
      id: "closing",
      error: undefined,
    });
});

test("a conflicting note rejects saving without changing the caller's draft", async () => {
  const f = fixture();
  let draft = "My pending investigation";
  f.sdk.beforeClose(async () => {
    await f.sdk.comment("finding", draft, 0);
    draft = "";
  });
  f.send({ type: "scope-retro-close", id: "closing" });
  await expect.poll(() => f.calls.some((call) => call.method === "comment")).toBe(true);
  const call = f.calls.find((call) => call.method === "comment")!;
  f.send({
    type: "scope-retro-reply",
    id: call.id,
    error: { message: "Report changed. Read it and retry.", code: "conflict" },
  });
  await expect
    .poll(() => f.calls.find((call) => call.type === "scope-retro-flushed")?.error)
    .toContain("Report changed");
  expect(draft).toBe("My pending investigation");
});
