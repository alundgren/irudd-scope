import { decode } from "@irudd-scope/protocol";
import { Uuid } from "../../workspace/contract.ts";
import type { MainPluginContext } from "../main-api.ts";
import { homedir } from "node:os";
import { findProgram } from "@irudd-scope/harnesses";
import { harnessPath } from "../../harnesses.ts";
import { claudeHarness } from "./chat/claude.ts";
import { registerCardChat } from "./chat/view.ts";
import {
  CanvasChange,
  CanvasIdRequest,
  CanvasStep,
  type CanvasActor,
  type CanvasChanged,
  type CanvasTarget,
  type CanvasWriteResult,
} from "./contract.ts";

export function registerCanvasIpc(context: MainPluginContext) {
  const { handle, artifacts, window } = context;
  const path = harnessPath();
  const chat = registerCardChat(context, [
    claudeHarness({
      // Tests point this at a fake program, so they never start the person's own claude.
      program: () => findProgram(process.env.SCOPE_CLAUDE_COMMAND || "claude", homedir(), path),
      path,
    }),
  ]);
  // Trimming board history can remove a deleted card for good, and with it its chat folder.
  let swept = 0;
  const sweepLater = () => {
    if (Date.now() - swept < 60_000) return;
    swept = Date.now();
    void chat.chats.sweep();
  };
  const canvases = artifacts.canvases;
  // The open view applies the person's own edits first; this tells it about every committed one.
  const announce = (
    tabId: string,
    target: CanvasTarget,
    actor: CanvasActor,
    result: CanvasWriteResult,
  ) => {
    if (!result.ok || window.isDestroyed()) return result;
    sweepLater();
    window.webContents.send("scope:canvas-changed", {
      tabId,
      target,
      version: result.version,
      actor,
    } satisfies CanvasChanged);
    return result;
  };
  handle("scope:canvas-read", (input) => canvases.snapshot(decode(Uuid, input)));
  handle("scope:canvas-change", async (input) => {
    const change = decode(CanvasChange, input);
    return announce(change.tabId, change.target, "person", await canvases.change(change, "person"));
  });
  handle("scope:canvas-step", async (input) => {
    const step = decode(CanvasStep, input);
    return announce(step.tabId, step.target, "person", await canvases.step(step, "person"));
  });
  handle("scope:canvas-ids", (input) => {
    const { tabId, count } = decode(CanvasIdRequest, input);
    return canvases.reserveIds(tabId, count);
  });
  return { dispose: () => chat.dispose(), removed: chat.removed };
}
