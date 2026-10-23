import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { decode } from "@irudd-scope/protocol";
import {
  assemblePrompt,
  emptyPromptDocument,
  PromptDocument,
  PromptExportManifest,
} from "@irudd-scope/protocol/prompts";
import { createPromptItem, promptPng, promptReply, promptsFixture } from "./prompts-fixture.ts";

test(
  "prompt workspace, curated items, images and original receipts survive restart while copies survive edits and deletion",
  { tags: ["prompts-keep-originals", "survives-restart"] },
  async () => {
    const f = await promptsFixture();
    try {
      const initial = promptReply(
        await f.client.prompts({ action: "read-workspace" }),
        "workspace",
      );
      expect(initial.workspace).toEqual({ revision: 0, document: emptyPromptDocument() });
      expect(promptReply(await f.client.prompts({ action: "list-items" }), "items").items).toEqual(
        [],
      );
      const create = createPromptItem();
      const created = await f.client.prompts(create);
      const image = await f.client.prompts({
        action: "set-image",
        requestId: randomUUID(),
        expectedRevision: 1,
        id: create.id,
        image: { mediaType: "image/png", base64: promptPng },
      });
      expect(image).toMatchObject({ itemRevision: 2, libraryRevision: 2 });
      const document = decode(PromptDocument, {
        ...emptyPromptDocument(),
        parts: {
          ...emptyPromptDocument().parts,
          subject: { itemId: create.id, text: "  my edited  bird; " },
          lighting: { itemId: null, text: "soft light" },
        },
      });
      await f.client.prompts({
        action: "update-workspace",
        requestId: randomUUID(),
        expectedRevision: 0,
        document,
      });
      await f.client.prompts({
        action: "update-item",
        requestId: randomUUID(),
        expectedRevision: 2,
        id: create.id,
        item: { ...create.item, fragment: "a blue bird" },
      });
      expect(
        promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace").workspace
          .document,
      ).toEqual(document);
      await f.restart();
      expect(await f.client.prompts(create)).toEqual(created);
      const saved = promptReply(
        await f.client.prompts({ action: "read-item", id: create.id }),
        "item",
      ).item;
      expect(saved).toMatchObject({
        revision: 3,
        fragment: "a blue bird",
        image: { size: Buffer.from(promptPng, "base64").length },
      });
      expect(Buffer.from(await f.client.promptImage(saved.id, saved.image!.id))).toEqual(
        Buffer.from(promptPng, "base64"),
      );
      expect(
        promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace").rendered,
      ).toBe("My edited bird. Soft light.");
      await f.client.prompts({
        action: "delete-item",
        requestId: randomUUID(),
        expectedRevision: 3,
        id: create.id,
      });
      const detached = promptReply(
        await f.client.prompts({ action: "read-workspace" }),
        "workspace",
      );
      expect(detached.workspace).toMatchObject({
        revision: 2,
        document: { parts: { subject: { itemId: null, text: "  my edited  bird; " } } },
      });
      await expect(f.client.promptImage(saved.id, saved.image!.id)).rejects.toMatchObject({
        status: 404,
      });
      const db = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
      try {
        expect(db.prepare("SELECT count(*) AS count FROM prompt_images").get()?.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "current reset keeps the library, and assembly follows fixed sentence order without rewriting internal punctuation",
  { tags: ["prompts-keep-originals"] },
  async () => {
    const f = await promptsFixture();
    try {
      await f.client.prompts(createPromptItem());
      const parts = {
        ...emptyPromptDocument().parts,
        subject: { itemId: null, text: "  red\n bird... " },
        action: { itemId: null, text: " flies, then rests;: " },
        environment: { itemId: null, text: " ...; " },
        camera: { itemId: null, text: "85mm lens" },
      };
      const document = decode(PromptDocument, { ...emptyPromptDocument(), parts });
      expect(assemblePrompt(document)).toBe("Red bird. Flies, then rests. 85mm lens.");
      await f.client.prompts({
        action: "update-workspace",
        requestId: randomUUID(),
        expectedRevision: 0,
        document,
      });
      await f.client.prompts({
        action: "reset-workspace",
        requestId: randomUUID(),
        expectedRevision: 1,
      });
      expect(
        promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace"),
      ).toMatchObject({
        workspace: { revision: 2, document: emptyPromptDocument() },
        rendered: "",
      });
      expect(
        promptReply(await f.client.prompts({ action: "list-items" }), "items").items,
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

test(
  "library-only ZIP contains original referenced images and separately saved scene metadata, excluding current prompt and unrelated artifacts",
  { tags: ["prompts-keep-originals"] },
  async () => {
    const f = await promptsFixture();
    try {
      await f.client.publish(
        "unrelated",
        {
          title: "Private artifact",
          kind: "text",
          mediaType: "text/plain",
          fileName: "report.txt",
          expectedRevision: 0,
        },
        Buffer.from("UNRELATED_ARTIFACT_TEXT"),
      );
      const create = createPromptItem();
      await f.client.prompts(create);
      await f.client.prompts({
        action: "set-image",
        requestId: randomUUID(),
        id: create.id,
        expectedRevision: 1,
        image: { mediaType: "image/png", base64: promptPng },
      });
      const document = decode(PromptDocument, {
        ...emptyPromptDocument(),
        parts: {
          ...emptyPromptDocument().parts,
          subject: { itemId: create.id, text: "CURRENT_WORKSPACE_DO_NOT_EXPORT" },
        },
      });
      await f.client.prompts({
        action: "update-workspace",
        requestId: randomUUID(),
        expectedRevision: 0,
        document,
      });
      const zip = await f.client.exportPromptLibrary();
      const files = unzipSync(zip);
      const manifest = decode(
        PromptExportManifest,
        JSON.parse(Buffer.from(files["manifest.json"]).toString()),
      );
      expect(manifest).toMatchObject({
        format: "scope-prompt-library",
        version: 1,
        libraryRevision: 2,
        itemCount: 1,
        structures: [{ assemblyId: "sentences-v1" }],
      });
      const items = JSON.parse(Buffer.from(files[manifest.itemsFile]).toString());
      expect(items).toMatchObject([
        { id: create.id, fragment: create.item.fragment, exampleScene: create.item.exampleScene },
      ]);
      expect(Object.keys(files).sort()).toEqual(
        ["manifest.json", "library.json", manifest.images[0].file].sort(),
      );
      expect(Buffer.from(files[manifest.images[0].file])).toEqual(Buffer.from(promptPng, "base64"));
      for (const bytes of Object.values(files)) {
        expect(Buffer.from(bytes).toString()).not.toContain("CURRENT_WORKSPACE_DO_NOT_EXPORT");
        expect(Buffer.from(bytes).toString()).not.toContain("UNRELATED_ARTIFACT_TEXT");
      }
      expect(
        promptReply(await f.client.prompts({ action: "read-workspace" }), "workspace").workspace
          .document,
      ).toEqual(document);
    } finally {
      await f.close();
    }
  },
);
