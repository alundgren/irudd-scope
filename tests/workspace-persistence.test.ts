import { expect, test } from "vite-plus/test";
import { beforeClose, flushWorkspace } from "../apps/desktop/src/workspace/persistence.ts";
import type { WorkspaceFlushPurpose } from "../apps/desktop/src/workspace/contract.ts";

test("routine saves keep tabs open and targeted closure only closes its owner", async () => {
  const calls: [string, WorkspaceFlushPurpose][] = [];
  const removeA = beforeClose(async (purpose) => {
    calls.push(["a", purpose]);
  }, "a");
  const removeB = beforeClose(async (purpose) => {
    calls.push(["b", purpose]);
  }, "b");
  try {
    await flushWorkspace();
    await flushWorkspace("close", "a");
    await flushWorkspace("close");
    expect(calls).toEqual([
      ["a", "save"],
      ["b", "save"],
      ["a", "close"],
      ["b", "save"],
      ["a", "close"],
      ["b", "close"],
    ]);
  } finally {
    removeA();
    removeB();
  }
});
