import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { decode, type LiveEvent } from "@irudd-scope/protocol";
import {
  emptyPromptDocument,
  PromptDocument,
  PROMPT_PAGE_SIZE,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_REQUEST_BYTES,
} from "@irudd-scope/protocol/prompts";
import {
  createPromptItem,
  promptPng,
  promptJpeg,
  promptWebp,
  promptReply,
  promptsFixture,
  promptToken,
} from "./prompts-fixture.ts";

test("prompt mutations reject stale revisions and changed retries atomically, with one event after each committed change", async () => {
  const f = await promptsFixture();
  const events: LiveEvent[] = [];
  const controller = new AbortController();
  const watching = f.client.watch((event) => events.push(event), controller.signal).catch(() => {});
  try {
    await expect.poll(() => events.some((event) => event.type === "ready")).toBe(true);
    const create = createPromptItem();
    const receipt = await f.client.prompts(create);
    await f.client.prompts({
      action: "update-item",
      requestId: randomUUID(),
      expectedRevision: 1,
      id: create.id,
      item: { ...create.item, name: "Current name" },
    });
    await expect.poll(() => events.filter((event) => event.type === "prompts").length).toBe(2);
    expect(await f.client.prompts(create)).toEqual(receipt);
    await expect(
      f.client.prompts({ ...create, item: { ...create.item, name: "Changed retry" } }),
    ).rejects.toMatchObject({ status: 409 });
    const before = events.length;
    const update = {
      action: "update-item" as const,
      expectedRevision: 2,
      id: create.id,
      item: { ...create.item, name: "Concurrent update" },
    };
    const concurrent = await Promise.allSettled([
      f.client.prompts({ ...update, requestId: randomUUID() }),
      f.client.prompts({ ...update, requestId: randomUUID() }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    await expect.poll(() => events.length).toBe(before + 1);
    const document = decode(PromptDocument, {
      ...emptyPromptDocument(),
      parts: { ...emptyPromptDocument().parts, subject: { itemId: create.id, text: "typed copy" } },
    });
    await f.client.prompts({
      action: "update-workspace",
      requestId: randomUUID(),
      expectedRevision: 0,
      document,
    });
    const wrong = decode(PromptDocument, {
      ...document,
      parts: { ...document.parts, camera: { itemId: create.id, text: "wrong field" } },
    });
    await expect(
      f.client.prompts({
        action: "update-workspace",
        requestId: randomUUID(),
        expectedRevision: 1,
        document: wrong,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.client.prompts({ action: "reset-workspace", requestId: randomUUID(), expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace").workspace
        .document,
    ).toEqual(document);
    await f.client.prompts({
      action: "delete-item",
      requestId: randomUUID(),
      expectedRevision: 3,
      id: create.id,
    });
    await expect.poll(() => events.filter((event) => event.type === "prompts").length).toBe(5);
    expect(events.at(-1)).toEqual({
      type: "prompts",
      workspaceRevision: 2,
      libraryRevision: 4,
      workspaceChanged: true,
      libraryChanged: true,
    });
  } finally {
    controller.abort();
    await watching;
    await f.close();
  }
});

test("bounded library pages have stable ID ordering, field/search filters and reject changed-library continuations", async () => {
  const f = await promptsFixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < PROMPT_PAGE_SIZE + 2; i++) {
      const create = createPromptItem(i % 2 ? "camera" : "subject");
      ids.push(create.id);
      await f.client.prompts(create);
    }
    const first = promptReply(await f.client.prompts({ action: "list-items" }), "items");
    expect(first.items.map((item) => item.id)).toEqual(ids.sort().slice(0, PROMPT_PAGE_SIZE));
    const last = promptReply(
      await f.client.prompts({ action: "list-items", cursor: first.next! }),
      "items",
    );
    expect(last.items.map((item) => item.id)).toEqual(ids.slice(PROMPT_PAGE_SIZE));
    expect(last.next).toBeNull();
    const filtered = promptReply(
      await f.client.prompts({ action: "list-items", field: "camera", search: "EXAMPLE CAMERA" }),
      "items",
    );
    expect(filtered.items).toHaveLength(13);
    expect(filtered.items.every((item) => item.field === "camera")).toBe(true);
    await f.client.prompts(createPromptItem());
    await expect(
      f.client.prompts({ action: "list-items", cursor: first.next! }),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await f.close();
  }
});

test.each([
  ["image/png", promptPng, 1, 1],
  ["image/jpeg", promptJpeg, 2, 3],
  ["image/webp", promptWebp, 2, 3],
] as const)(
  "%s example images retain original bytes and metadata and enforce current ownership",
  async (mediaType, base64, width, height) => {
    const f = await promptsFixture();
    try {
      const create = createPromptItem();
      await f.client.prompts(create);
      const other = createPromptItem();
      await f.client.prompts(other);
      await f.client.prompts({
        action: "set-image",
        requestId: randomUUID(),
        expectedRevision: 1,
        id: create.id,
        image: { mediaType, base64 },
      });
      const item = promptReply(
        await f.client.prompts({ action: "read-item", id: create.id }),
        "item",
      ).item;
      expect(item.image).toMatchObject({
        mediaType,
        width,
        height,
        size: Buffer.from(base64, "base64").length,
      });
      const response = await fetch(
        `${f.server.url}/v1/prompts/items/${create.id}/images/${item.image!.id}`,
        { headers: { Authorization: `Bearer ${promptToken}` } },
      );
      expect(response.headers.get("content-type")).toBe(mediaType);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(base64, "base64"));
      await expect(f.client.promptImage(other.id, item.image!.id)).rejects.toMatchObject({
        status: 404,
      });
      await f.client.prompts({
        action: "set-image",
        requestId: randomUUID(),
        id: create.id,
        expectedRevision: 2,
        image: null,
      });
      await expect(f.client.promptImage(create.id, item.image!.id)).rejects.toMatchObject({
        status: 404,
      });
      expect(
        promptReply(await f.client.prompts({ action: "read-item", id: create.id }), "item").item
          .image,
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

test("malformed, MIME-mismatched, oversized and invalid-dimension images do not change records or retain bytes", async () => {
  const f = await promptsFixture();
  try {
    const create = createPromptItem();
    await f.client.prompts(create);
    const invalidPng = Buffer.from(promptPng, "base64");
    invalidPng.writeUInt32BE(4097, 16);
    invalidPng.writeUInt32BE(crc32(invalidPng.subarray(12, 29)), 29);
    const badCrc = Buffer.from(promptPng, "base64");
    badCrc[45] ^= 1;
    const wrongWebp = Buffer.from(promptWebp, "base64");
    wrongWebp.writeUInt32LE(5000, 4);
    for (const image of [
      { mediaType: "image/jpeg", base64: promptPng },
      { mediaType: "image/png", base64: "not base64" },
      { mediaType: "image/png", base64: Buffer.from("not an image").toString("base64") },
      { mediaType: "image/png", base64: badCrc.toString("base64") },
      { mediaType: "image/png", base64: invalidPng.toString("base64") },
      {
        mediaType: "image/jpeg",
        base64: Buffer.from(promptJpeg, "base64").subarray(0, -2).toString("base64"),
      },
      { mediaType: "image/webp", base64: wrongWebp.toString("base64") },
      {
        mediaType: "image/png",
        base64: Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1).toString("base64"),
      },
    ]) {
      const response = await fetch(`${f.server.url}/v1/prompts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${promptToken}` },
        body: JSON.stringify({
          action: "set-image",
          requestId: randomUUID(),
          expectedRevision: 1,
          id: create.id,
          image,
        }),
      });
      expect(
        [400, 413],
        `${image.mediaType} length=${image.base64.length} response=${await response.text()}`,
      ).toContain(response.status);
    }
    expect(
      promptReply(await f.client.prompts({ action: "read-item", id: create.id }), "item"),
    ).toMatchObject({ libraryRevision: 1, item: { revision: 1 } });
    const db = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM prompt_images").get()?.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("prompt HTTP validates authentication, origins, methods, bodies and request limits", async () => {
  const f = await promptsFixture();
  try {
    const request = (path: string, init: RequestInit = {}) => fetch(`${f.server.url}${path}`, init);
    expect(
      (await request("/v1/prompts", { method: "POST", body: '{"action":"structures"}' })).status,
    ).toBe(401);
    expect((await request("/v1/prompts/export")).status).toBe(401);
    const headers = { Authorization: `Bearer ${promptToken}` };
    expect(
      (
        await request("/v1/prompts", {
          method: "POST",
          headers: { ...headers, Origin: "https://example.com" },
          body: '{"action":"structures"}',
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { action: "generate" },
      { action: "structures", extra: true },
      { action: "reset-workspace", expectedRevision: 0, requestId: "bad" },
      {
        action: "update-workspace",
        expectedRevision: 0,
        requestId: randomUUID(),
        document: { parts: {} },
      },
    ])
      expect(
        (await request("/v1/prompts", { method: "POST", headers, body: JSON.stringify(body) }))
          .status,
      ).toBe(400);
    expect(
      (
        await request("/v1/prompts?x=1", {
          method: "POST",
          headers,
          body: '{"action":"structures"}',
        })
      ).status,
    ).toBe(400);
    expect((await request("/v1/prompts/export", { method: "DELETE", headers })).status).toBe(404);
    expect(
      (
        await request("/v1/prompts", {
          method: "POST",
          headers,
          body: " ".repeat(MAX_PROMPT_REQUEST_BYTES + 1),
        })
      ).status,
    ).toBe(413);
    expect(promptReply(await f.client.prompts({ action: "list-items" }), "items").items).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});
