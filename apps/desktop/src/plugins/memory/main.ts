import { clipboard, shell } from "electron";
import { decode } from "@irudd-scope/protocol";
import { Schema } from "effect";
import type { MainPluginContext } from "../main-api.ts";

export function registerMemoryIpc({ handle }: MainPluginContext) {
  handle("scope:copy-memory-draft", (input) =>
    clipboard.writeText(decode(Schema.String.check(Schema.isMaxLength(1_000_000)), input)),
  );
  handle("scope:open-memory-link", async (input) => {
    const url = new URL(decode(Schema.String.check(Schema.isMaxLength(8192)), input));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Memory links must use HTTP or HTTPS without embedded credentials.");
    await shell.openExternal(url.href);
  });
}
