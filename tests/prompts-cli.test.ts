import { expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import { emptyPromptDocument } from "@irudd-scope/protocol/prompts";
import {
  createPromptItem,
  promptJpeg,
  promptReply,
  promptsFixture,
  promptToken,
} from "./prompts-fixture.ts";

const exec = promisify(execFile);
test("built prompts CLI discovers structures, curates library, prepares current prompt, uploads local image and exports only library to a new path", async () => {
  const f = await promptsFixture();
  const env = {
    ...process.env,
    SCOPE_ENDPOINT: f.server.url,
    SCOPE_TOKEN: promptToken,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_CONNECTION_FILE: undefined,
  };
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), "prompts", ...args], {
          env,
        })
      ).stdout,
    );
  const apply = async (command: unknown) => {
    const file = join(f.directory, "request.json");
    await writeFile(file, JSON.stringify(command));
    return cli("apply", file);
  };
  try {
    const guide = await cli("guide");
    expect(guide.schema).toBeDefined();
    expect(guide.availability).toContain("never queued");
    expect(await cli("structures")).toMatchObject({
      type: "structures",
      structures: [{ structureId: "text-to-image-seven" }],
    });
    expect(await cli("list")).toMatchObject({ items: [] });
    const create = createPromptItem();
    expect(await apply(create)).toMatchObject({ itemId: create.id, itemRevision: 1 });
    const imageRequest = join(f.directory, "image-request.json");
    await writeFile(
      imageRequest,
      JSON.stringify({
        action: "set-image",
        requestId: randomUUID(),
        expectedRevision: 1,
        id: create.id,
      }),
    );
    const file = join(f.directory, "example.jpg");
    await writeFile(file, Buffer.from(promptJpeg, "base64"));
    expect(await cli("image", imageRequest, file)).toMatchObject({ itemRevision: 2 });
    const item = (await cli("item", create.id)).item;
    expect(item.image.mediaType).toBe("image/jpeg");
    const document = {
      ...emptyPromptDocument(),
      parts: {
        ...emptyPromptDocument().parts,
        subject: { itemId: create.id, text: "CLI_CURRENT_TEXT_ONLY" },
      },
    };
    await apply({
      action: "update-workspace",
      requestId: randomUUID(),
      expectedRevision: 0,
      document,
    });
    expect(await cli("read")).toMatchObject({
      rendered: "CLI_CURRENT_TEXT_ONLY.",
      workspace: { revision: 1 },
    });
    const output = join(f.directory, "library.zip");
    expect(await cli("export", "--output", output)).toMatchObject({
      exported: true,
      version: 1,
      output,
    });
    const files = unzipSync(await readFile(output));
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
    expect(manifest.images[0].file).toMatch(/\.jpg$/);
    expect(Buffer.from(files[manifest.images[0].file])).toEqual(Buffer.from(promptJpeg, "base64"));
    expect(Buffer.from(files["library.json"]).toString()).not.toContain("CLI_CURRENT_TEXT_ONLY");
    const original = await readFile(output);
    await expect(cli("export", "--output", output)).rejects.toThrow();
    expect(await readFile(output)).toEqual(original);
    await expect(
      apply({ action: "reset-workspace", requestId: randomUUID(), expectedRevision: 0 }),
    ).rejects.toThrow("Current prompt changed");
    await apply({ action: "reset-workspace", requestId: randomUUID(), expectedRevision: 1 });
    expect((await cli("read")).rendered).toBe("");
    expect(
      promptReply(await f.client.prompts({ action: "list-items" }), "items").items,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
