import { Schema } from "effect";
import { PublicationTabId, ScopeError, decode } from "@irudd-scope/protocol";
import { RetroCommand } from "@irudd-scope/protocol/retro";
import type { MainPluginContext } from "../main-api.ts";

export function registerRetroIpc({ handle, artifacts, store, window }: MainPluginContext) {
  const pending = new Map<
    string,
    {
      tabId: string;
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const cancel = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error("Scope could not flush the retrospective because the renderer closed."),
      );
    }
    pending.clear();
  };
  window.webContents.on("render-process-gone", cancel);
  window.webContents.on("destroyed", cancel);
  artifacts.retros.setBeforeFinish((command) => {
    const existing = pending.get(command.requestId);
    if (existing) {
      if (existing.tabId !== command.tabId)
        return Promise.reject(new Error("This finish request is already flushing another tab."));
      return existing.promise;
    }
    if (window.isDestroyed() || window.webContents.isDestroyed())
      return Promise.reject(new Error("Open Scope before finishing the retrospective."));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => {
      pending.delete(command.requestId);
      reject(
        new Error(
          "Scope timed out saving retrospective edits. Keep the report open and try again.",
        ),
      );
    }, 15000);
    pending.set(command.requestId, { tabId: command.tabId, promise, resolve, reject, timer });
    window.webContents.send("scope:retro-finish-flush", {
      tabId: command.tabId,
      requestId: command.requestId,
    });
    return promise;
  });
  handle("scope:retro-finish-flushed", (value) => {
    const acknowledgement = decode(
      Schema.Struct({
        tabId: PublicationTabId,
        requestId: PublicationTabId,
        success: Schema.Boolean,
        error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
      }),
      value,
    );
    const request = pending.get(acknowledgement.requestId);
    if (!request) return;
    if (request.tabId !== acknowledgement.tabId)
      throw new ScopeError(409, "This flush acknowledgement belongs to another retrospective.");
    pending.delete(acknowledgement.requestId);
    clearTimeout(request.timer);
    if (acknowledgement.success) request.resolve();
    else request.reject(new Error(acknowledgement.error ?? "Could not save retrospective edits."));
  });
  handle("scope:retro-command", (value) => {
    const command = decode(RetroCommand, value);
    if (
      ![
        "read",
        "history",
        "decide",
        "comment",
        "request",
        "state-read",
        "state-set",
        "state-patch",
        "state-delete",
      ].includes(command.action)
    )
      throw new Error("This retrospective action requires the operator's agent.");
    return artifacts.retros.command(command);
  });
  handle("scope:retro-configuration", () => store.retroConfiguration());
  handle("scope:save-retro-configuration", (value) => {
    const command = decode(RetroCommand, { ...(value as object), action: "configure" });
    if (command.action !== "configure") throw new Error("Invalid retrospective configuration.");
    return store.saveRetroConfiguration(command);
  });
  return {
    dispose: () => {
      cancel();
      artifacts.retros.setBeforeFinish(undefined);
      window.webContents.removeListener("render-process-gone", cancel);
      window.webContents.removeListener("destroyed", cancel);
    },
  };
}
