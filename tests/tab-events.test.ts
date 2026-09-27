import { expect, test } from "vite-plus/test";
import { TabEventRouter } from "../apps/desktop/src/workspace/events.ts";
import type { Tab } from "../apps/desktop/src/workspace/contract.ts";
import type { TabEventEnvelope } from "../apps/desktop/src/plugins/events.ts";

function tab(groupId: string): Tab {
  return {
    id: crypto.randomUUID(),
    groupId,
    type: "test",
    title: "Test",
    state: { version: 1, data: {} },
  };
}

test("tabs communicate only within their group while the host observes all groups", () => {
  const a = tab(crypto.randomUUID());
  const b = tab(a.groupId);
  const c = tab(crypto.randomUUID());
  const failures: unknown[] = [];
  const router = new TabEventRouter((error) => failures.push(error));
  router.update([a, b, c]);
  const sender = router.forTab(a.id);
  const sibling = router.forTab(b.id);
  const outsider = router.forTab(c.id);
  const received: string[] = [];
  const hosted: TabEventEnvelope[] = [];
  router.subscribe((event) => {
    hosted.push(event);
  });
  sender.on("resource.selected", () => {
    received.push("self");
  });
  sibling.on("resource.selected", () => {
    received.push("same group");
  });
  outsider.on("resource.selected", () => {
    received.push("other group");
  });
  const event = { type: "resource.selected" as const, resource: { kind: "test", id: "selected" } };
  sender.emit(event);
  expect(received).toEqual(["same group"]);
  expect(hosted).toEqual([{ tabId: a.id, groupId: a.groupId, event }]);
  outsider.emit(event);
  expect(received).toEqual(["same group"]);
  expect(hosted.at(-1)?.groupId).toBe(c.groupId);
  sibling.dispose();
  sender.emit(event);
  expect(received).toEqual(["same group"]);
  router.update([b, c]);
  sender.emit(event);
  expect(hosted).toHaveLength(3);
  router.update([a, b, c]);
  sender.emit(event);
  expect(hosted).toHaveLength(3);
  router.forTab(a.id).emit(event);
  expect(hosted).toHaveLength(4);
  expect(failures).toEqual([]);
});

test("one broken listener cannot block delivery and event input is validated", () => {
  const a = tab(crypto.randomUUID());
  const b = tab(a.groupId);
  const failures: unknown[] = [];
  const router = new TabEventRouter((error) => failures.push(error));
  router.update([a, b]);
  router.forTab(b.id).on("resource.saved", () => {
    throw new Error("Broken observer");
  });
  const received: number[] = [];
  router.forTab(b.id).on("resource.saved", (event) => {
    received.push(event.revision);
  });
  router
    .forTab(a.id)
    .emit({ type: "resource.saved", resource: { kind: "artifact", id: "report" }, revision: 2 });
  expect(received).toEqual([2]);
  expect(failures).toHaveLength(1);
  expect(() =>
    router
      .forTab(a.id)
      .emit({ type: "resource.saved", resource: { kind: "artifact", id: "report" }, revision: -1 }),
  ).toThrow();
  expect(received).toEqual([2]);
});

test("moving a tab to another group invalidates its old event subscription", async () => {
  const a = tab(crypto.randomUUID());
  const b = tab(a.groupId);
  const c = tab(crypto.randomUUID());
  const errors: unknown[] = [];
  const router = new TabEventRouter((error) => errors.push(error));
  router.update([a, b, c]);
  const old = router.forTab(b.id);
  const received: string[] = [];
  old.on("resource.selected", () => {
    received.push("old");
  });
  router.update([a, { ...b, groupId: c.groupId }, c]);
  const current = router.forTab(b.id);
  current.on("resource.selected", () => {
    received.push("new");
  });
  current.on("resource.selected", async () => {
    throw new Error("Failed async observer");
  });
  router
    .forTab(c.id)
    .emit({ type: "resource.selected", resource: { kind: "test", id: "selection" } });
  await Promise.resolve();
  expect(received).toEqual(["new"]);
  expect(errors).toHaveLength(1);
});
