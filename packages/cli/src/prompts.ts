import { readFile, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { decode } from "@irudd-scope/protocol";
import {
  PromptCommand,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_REQUEST_BYTES,
} from "@irudd-scope/protocol/prompts";
import type { ScopeClient } from "@irudd-scope/protocol/client";

export async function promptsCommand(
  client: ScopeClient,
  positionals: string[],
  options: { output?: string },
  signal: AbortSignal,
) {
  const [, action, argument, imageFile] = positionals;
  if (action === "structures") return client.prompts({ action: "structures" });
  if (action === "read") return client.prompts({ action: "read-workspace" });
  if (action === "list") return client.prompts({ action: "list-items" });
  if (action === "item" && argument)
    return client.prompts(decode(PromptCommand, { action: "read-item", id: argument }));
  if (action === "export") {
    if (!options.output)
      throw new Error("Prompt library export requires --output with a new ZIP path.");
    const bytes = await client.exportPromptLibrary();
    await writeFile(options.output, bytes, { flag: "wx", signal });
    return {
      exported: true,
      format: "scope-prompt-library",
      version: 1,
      output: options.output,
      size: bytes.byteLength,
    };
  }
  if ((action === "apply" || action === "image") && argument) {
    if ((await stat(argument)).size > MAX_PROMPT_REQUEST_BYTES)
      throw new Error("Prompt command exceeds 12 MiB.");
    let input: unknown = JSON.parse(await readFile(argument, { encoding: "utf8", signal }));
    if (action === "image") {
      if (!imageFile) throw new Error("Use prompts image REQUEST.json IMAGE_FILE.");
      if (
        !input ||
        typeof input !== "object" ||
        !("action" in input) ||
        input.action !== "set-image" ||
        "image" in input
      )
        throw new Error(
          "Image request must use action=set-image and omit image. Provide requestId, id and expectedRevision.",
        );
      if ((await stat(imageFile)).size > MAX_PROMPT_IMAGE_BYTES)
        throw new Error("Example image exceeds 8 MiB.");
      const mediaType = (
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".webp": "image/webp",
        } as Record<string, string>
      )[extname(imageFile).toLowerCase()];
      if (!mediaType) throw new Error("Example image must be PNG, JPEG or WebP.");
      const bytes = await readFile(imageFile, { signal });
      if (bytes.length > MAX_PROMPT_IMAGE_BYTES) throw new Error("Example image exceeds 8 MiB.");
      input = { ...input, image: { mediaType, base64: bytes.toString("base64") } };
    }
    return client.prompts(decode(PromptCommand, input));
  }
  throw new Error("Use prompts guide for supported commands.");
}
