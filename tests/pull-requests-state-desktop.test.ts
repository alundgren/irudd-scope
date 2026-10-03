import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { desktopFixture } from "./desktop-fixture.ts";

type State = { version: number; value: Record<string, unknown> };
type StateSDK = {
  read: () => Promise<State>;
  set: (value: Record<string, unknown>, version: number) => Promise<State>;
  patch: (value: Record<string, unknown>, version: number) => Promise<State>;
  delete: (keys: string[], version: number) => Promise<State>;
};
type InboxWindow = {
  scope: {
    pullRequests: { state: StateSDK };
    windows: { open: (content: { title: string; html: string }) => Promise<string> };
  };
};
const html = `<!doctype html><h1>State inbox</h1><p id="state"></p><script>
window.updates=[];window.stopState=scope.pullRequests.state.watch(update=>{
  updates.push(update);document.getElementById('state').textContent=JSON.stringify(update);
});
window.draft=null;scope.pullRequests.beforeClose(async()=>{
  if(!window.draft)return;
  const current=await scope.pullRequests.state.read();
  await scope.pullRequests.state.patch(window.draft,current.version);window.draft=null;
});
</script>`;

test("authored inbox JSON edits reach all its frames and survive restart and HTML replacement", async () => {
  const f = await desktopFixture();
  let app = await f.launch();
  try {
    let client = await f.connect();
    await client.publish(
      "state-inbox",
      {
        name: "state-inbox",
        title: "State inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: 0,
      },
      Buffer.from(html),
    );
    const page = await app.firstWindow();
    const main = page.frameLocator(".pull-requests-document");
    await main.locator("#state").filter({ hasText: '"version":0' }).waitFor();
    const initial = await main
      .locator("body")
      .evaluate(() => (window as unknown as InboxWindow).scope.pullRequests.state.read());
    expect(initial).toEqual({ version: 0, value: {} });
    await main
      .locator("body")
      .evaluate(
        (_body, html) =>
          (window as unknown as InboxWindow).scope.windows.open({ title: "State child", html }),
        html,
      );
    const child = page.frameLocator('iframe[title="State child"]');
    await child.locator("#state").filter({ hasText: '"version":0' }).waitFor();
    const saved = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.set(
          { hidden: ["file.ts"], pane: { width: 300 } },
          0,
        ),
      );
    expect(saved.version).toBe(1);
    await child.locator("#state").filter({ hasText: '"operation":"set"' }).waitFor();
    const patched = await child
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.patch(
          { pane: { width: 450 }, nullable: null },
          1,
        ),
      );
    expect(patched).toEqual({
      version: 2,
      value: { hidden: ["file.ts"], pane: { width: 450 }, nullable: null },
    });
    await main.locator("#state").filter({ hasText: '"operation":"patch"' }).waitFor();
    const failure = await main.locator("body").evaluate(async () => {
      try {
        await (window as unknown as InboxWindow).scope.pullRequests.state.delete(["hidden"], 1);
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("state changed");
    await child
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.delete(["hidden"], 2),
      );
    await main.locator("#state").filter({ hasText: '"operation":"delete"' }).waitFor();
    const reply = await client.pullRequests({ action: "read", name: "state-inbox" });
    if (reply.type !== "snapshot") throw new Error("Expected snapshot");
    await client.pullRequests({
      action: "state-patch",
      name: "state-inbox",
      tabId: reply.snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: 3,
      value: { external: true },
    });
    await main.locator("#state").filter({ hasText: '"version":4' }).waitFor();
    await child.locator("#state").filter({ hasText: '"version":4' }).waitFor();
    await app.evaluate(
      ({ BrowserWindow }, { id, name }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
          type: "pull-requests",
          id,
          name,
          tabId: "11111111-1111-4111-8111-111111111111",
          generation: 99,
          stateChange: { operation: "set", version: 99, value: { replacementInbox: true } },
        });
      },
      { id: reply.snapshot.artifact.id, name: reply.snapshot.artifact.name },
    );
    const current = await main
      .locator("body")
      .evaluate(() => (window as unknown as InboxWindow).scope.pullRequests.state.read());
    expect(current.version).toBe(4);
    expect(await main.locator("#state").textContent()).toContain('"version":4');
    const updates = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as { updates: { version: number; operation: string }[] }).updates.map(
          ({ version, operation }) => ({ version, operation }),
        ),
      );
    expect(updates).toEqual([
      { version: 0, operation: "snapshot" },
      { version: 1, operation: "set" },
      { version: 2, operation: "patch" },
      { version: 3, operation: "delete" },
      { version: 4, operation: "patch" },
    ]);
    // Unsubscribed HTML components stop receiving updates while the rest stay live.
    await child
      .locator("body")
      .evaluate(() => (window as unknown as { stopState: () => void }).stopState());
    const last = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.patch({ sidebar: 280 }, 4),
      );
    expect(last.version).toBe(5);
    await main.locator("#state").filter({ hasText: '"version":5' }).waitFor();
    expect(await child.locator("#state").textContent()).toContain('"version":4');
    await main.locator("body").evaluate(() => {
      (window as unknown as { draft: unknown }).draft = { savedOnReplacement: true };
    });
    const artifact = await client.get("state-inbox");
    await client.publish(
      "state-inbox",
      {
        name: "state-inbox",
        title: "Updated state inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: artifact.revision,
      },
      Buffer.from(html.replace("State inbox", "Updated state inbox")),
    );
    await main.getByRole("heading", { name: "Updated state inbox" }).waitFor();
    await main.locator("#state").filter({ hasText: '"version":6' }).waitFor();
    await app.close();
    app = await f.launch();
    client = await f.connect();
    const restarted = await app.firstWindow();
    await restarted
      .frameLocator(".pull-requests-document")
      .locator("#state")
      .filter({ hasText: '"version":6' })
      .waitFor();
    const restored = await client.pullRequests({ action: "read", name: "state-inbox" });
    expect(restored.type === "snapshot" && restored.snapshot.appState).toEqual({
      version: 6,
      value: { ...last.value, savedOnReplacement: true },
    });
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
