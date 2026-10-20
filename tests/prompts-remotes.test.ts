import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";
import {
  createPromptItem,
  promptPng,
  promptReply,
  promptsFixture,
  promptToken,
} from "./prompts-fixture.ts";

test("paired hub forwards authenticated prompt commands/images/export/events live, and never buffers them offline", async () => {
  const f = await promptsFixture();
  const state = await HubState.open(join(f.directory, "hub"));
  const connectionFile = join(f.directory, "connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const store = new DesktopStore(join(f.directory, "desktop"), memoryCredentials());
  await store.load();
  const remotes = new Remotes(store, { url: f.server.url, token: promptToken }, () => {});
  const client = new ScopeClient(hub.url, local.token);
  const controller = new AbortController();
  let watching: Promise<void> | undefined;
  try {
    await remotes.start();
    await expect(client.prompts({ action: "read-workspace" })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("disconnected"),
    });
    await remotes.pair(state.pairUrl());
    await expect.poll(() => remotes.snapshot()[0]?.connection).toBe("connected");
    const events: string[] = [];
    watching = client.watch((event) => events.push(event.type), controller.signal).catch(() => {});
    await expect.poll(() => events).toContain("ready");
    const create = createPromptItem();
    // More than the relay's ordinary 16 KiB metadata limit, without large test content.
    const item = {
      ...create.item,
      fragment: "f".repeat(8192),
      exampleScene: { title: "Large scene", prompt: "s".repeat(8192) },
    };
    await client.prompts({ ...create, item });
    await client.prompts({
      action: "set-image",
      requestId: randomUUID(),
      expectedRevision: 1,
      id: create.id,
      image: { mediaType: "image/png", base64: promptPng },
    });
    const saved = promptReply(
      await client.prompts({ action: "read-item", id: create.id }),
      "item",
    ).item;
    expect(saved.fragment).toBe(item.fragment);
    expect(Buffer.from(await client.promptImage(create.id, saved.image!.id))).toEqual(
      Buffer.from(promptPng, "base64"),
    );
    expect(
      Buffer.from(await client.exportPromptLibrary())
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
    await expect.poll(() => events).toContain("prompts");
    await remotes.setEnabled(remotes.snapshot()[0].id, false);
    await expect(
      client.prompts({ action: "reset-workspace", requestId: randomUUID(), expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(client.exportPromptLibrary()).rejects.toMatchObject({ status: 503 });
    const response = await fetch(`${hub.url}/v1/hub/queue`, {
      headers: { Authorization: `Bearer ${local.token}` },
    });
    expect((await response.json()).items).toEqual([]);
    expect(
      promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace").workspace
        .revision,
    ).toBe(0);
  } finally {
    controller.abort();
    await watching;
    await remotes.close();
    await store.close();
    await hub.close();
    state.close();
    await f.close();
  }
});
