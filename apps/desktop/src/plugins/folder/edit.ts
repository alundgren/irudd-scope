import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { FolderRelativePath } from "@irudd-scope/protocol/folder";
import {
  FolderFileVersion,
  type FolderOperationRequest,
} from "@irudd-scope/protocol/folder-operation";
import { FolderError } from "@irudd-scope/folder";
import { Uuid } from "../../workspace/contract.ts";
import { RemoteUnavailableError } from "../../remotes.ts";
import type { FolderFileSaveResult } from "./contract.ts";
import { FolderUpdateNeeded } from "./source.ts";
import type { Folder, FolderTransfers } from "./transfer.ts";

/** Saves made in this desktop's editor. */
const EDITOR_CALLER = "scope-editor";
/** The editor holds at most a 2 MiB preview; UTF-8 needs at most three bytes per unit. */
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

const FileRequest = Schema.Struct({
  tabId: Uuid,
  path: FolderRelativePath.check(Schema.isMinLength(1)),
});
const SaveRequest = Schema.Struct({
  ...FileRequest.fields,
  text: Schema.String.check(Schema.isMaxLength(MAX_TEXT_LENGTH)),
  expectedVersion: FolderFileVersion,
});

function failure(error: unknown): string {
  if (
    error instanceof FolderUpdateNeeded ||
    (error instanceof FolderError && error.code === "unsupported")
  )
    return "Update Scope on the folder's machine to edit files.";
  if (error instanceof RemoteUnavailableError || error instanceof TypeError)
    return "The folder's machine is offline. Your changes are still here.";
  return error instanceof Error ? error.message : "The file could not be saved.";
}

/**
 * Text edits to files in Folder tabs. Each save is a versioned folder operation on the
 * folder's machine that replaces the file only while it still has the version the editor
 * read, so a file changed by anyone else is never overwritten without being asked again.
 * Scope keeps the text only in the open editor.
 */
export function registerFolderEdits({
  handle,
  folder,
  exclusive,
}: {
  handle: (channel: string, action: (input: unknown) => unknown) => void;
  folder: (tabId: string) => Promise<Folder>;
} & Pick<FolderTransfers, "exclusive">) {
  async function version(tabId: string, path: string) {
    const { source } = await folder(tabId);
    return source.operations.version(path, AbortSignal.timeout(60_000));
  }

  handle("scope:folder-file-version", async (input) => {
    const request = decode(FileRequest, input);
    try {
      return { status: "ok", version: await version(request.tabId, request.path) };
    } catch (error) {
      return { status: "failed", message: failure(error) };
    }
  });

  handle("scope:folder-file-save", async (input): Promise<FolderFileSaveResult> => {
    const request = decode(SaveRequest, input);
    const bytes = Buffer.from(request.text, "utf8");
    try {
      return await exclusive(request.tabId, async () => {
        const { source } = await folder(request.tabId);
        const operation: FolderOperationRequest = {
          version: 1,
          requestId: `${Date.now()}:${randomUUID()}`,
          path: request.path,
          kind: "file",
          expectedVersion: request.expectedVersion,
          replace: request.expectedVersion !== "missing",
          payload: {
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        };
        const signal = AbortSignal.timeout(120_000);
        const outcome = await source.operations.execute(
          EDITOR_CALLER,
          operation,
          Readable.from([bytes]),
          signal,
        );
        if (outcome.state === "completed")
          return { status: "saved", version: await version(request.tabId, request.path) };
        // A conflict proves nothing was written; the editor still has the text.
        if (outcome.error?.code === "conflict")
          return { status: "conflict", version: await version(request.tabId, request.path) };
        if (outcome.state === "failed")
          return { status: "failed", message: outcome.error?.error ?? "The file was not saved." };
        return {
          status: "failed",
          message: "Scope could not confirm the save. Reload the file to check it.",
        };
      });
    } catch (error) {
      return { status: "failed", message: failure(error) };
    }
  });
}
