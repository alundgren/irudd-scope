import { clipboard, shell } from "electron";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@irudd-scope/protocol";
import { Schema } from "effect";
import type { MainPluginContext } from "../main-api.ts";
import {
  MemoryCommand,
  MemoryConcept,
  MemoryGraph,
  MemorySaved,
  MemorySearch,
  type MemoryReply,
} from "./contract.ts";

const CliError = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

export function registerMemoryIpc({ handle, workspace, memory }: MainPluginContext) {
  handle("scope:memory-command", async (input): Promise<MemoryReply> => {
    const command = decode(MemoryCommand, input);
    if (!(await workspace()).tabs.some((tab) => tab.id === command.tabId && tab.type === "memory"))
      throw new Error("Open Personal memory before reading or editing its files.");
    let directory: string | undefined;
    let received = false;
    try {
      let args: string[];
      switch (command.action) {
        case "read":
          args = ["read", "personal", command.path];
          break;
        case "search":
          args = [
            "search",
            // irudd-okf has no `--` separator, so the space keeps a query like
            // "--help" from being read as a flag. irudd-okf echoes it unchanged.
            ` ${command.query}`,
            "--scope",
            "personal",
            "--limit",
            "30",
            "--offset",
            String(command.offset),
          ];
          break;
        case "graph":
          args = [
            "graph",
            "--scope",
            "personal",
            "--depth",
            "2",
            "--limit",
            "80",
            ...(command.path ? ["--path", command.path] : []),
          ];
          break;
        case "save": {
          if (Buffer.byteLength(command.raw) > 1_000_000)
            throw new Error("Memory files must stay below 1 MB.");
          directory = await mkdtemp(join(tmpdir(), "scope-memory-edit-"));
          const file = join(directory, "input.md");
          await writeFile(file, command.raw, { mode: 0o600 });
          args = [
            "write",
            "personal",
            command.path,
            "--file",
            file,
            "--expected",
            command.expectedHash,
            "--authorize-personal",
          ];
          break;
        }
      }
      const result = await memory.runOkf(command.repository, args);
      if (result.code !== 0) {
        try {
          const { error } = Schema.decodeUnknownSync(CliError)(
            JSON.parse(result.stderr || result.stdout),
          );
          return {
            action: "error",
            code: error.code.slice(0, 128),
            message: error.message.slice(0, 2048),
          };
        } catch {
          return {
            action: "error",
            code: "CLI_FAILED",
            message:
              "irudd-okf could not complete this operation. Check Memory in Settings and retry. Your draft is kept.",
          };
        }
      }
      received = true;
      const value: unknown = JSON.parse(result.stdout);
      switch (command.action) {
        case "read": {
          const concept = Schema.decodeUnknownSync(MemoryConcept)(value);
          if (concept.path !== command.path)
            throw new Error("irudd-okf returned a different file.");
          return { action: "read", concept };
        }
        case "search": {
          const search = Schema.decodeUnknownSync(MemorySearch)(value);
          if (
            search.query !== ` ${command.query}` ||
            search.offset !== command.offset ||
            search.limit !== 30 ||
            search.results.length !== Math.min(30, Math.max(0, search.total - search.offset))
          )
            throw new Error("irudd-okf returned inconsistent search results.");
          return { action: "search", search };
        }
        case "graph":
          return { action: "graph", graph: Schema.decodeUnknownSync(MemoryGraph)(value) };
        case "save": {
          const saved = Schema.decodeUnknownSync(MemorySaved)(value);
          if (saved.path !== command.path) throw new Error("irudd-okf returned a different file.");
          if (saved.hash !== createHash("sha256").update(command.raw).digest("hex"))
            throw new Error("irudd-okf returned an inconsistent saved version.");
          return { action: "save", hash: saved.hash };
        }
      }
    } catch (cause) {
      return {
        action: "error",
        code: "UNAVAILABLE",
        message: received
          ? "irudd-okf returned unreadable memory data. Update it in Settings and retry. Your draft is kept."
          : cause instanceof Error
            ? cause.message.slice(0, 2048)
            : "Memory could not be loaded. Retry. Your draft is kept.",
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  handle("scope:copy-memory-draft", (input) => {
    return clipboard.writeText(decode(Schema.String.check(Schema.isMaxLength(1_000_000)), input));
  });
  handle("scope:open-memory-link", async (input) => {
    const url = new URL(decode(Schema.String.check(Schema.isMaxLength(8192)), input));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Memory links must use HTTP or HTTPS without embedded credentials.");
    await shell.openExternal(url.href);
  });
}
