import { app, ipcMain, WebContentsView, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { decode } from "@irudd-scope/protocol";
import type { MainPluginContext } from "../../main-api.ts";
import {
  ChatApprove,
  ChatLayout,
  ChatProgramsRequest,
  ChatSend,
  ChatUndoTurn,
  type ChatBounds,
  type ChatTarget,
  type ChatTheme,
} from "./contract.ts";
import type { CardToolService } from "./card-tools.ts";
import type { ChatHarness } from "./harness.ts";
import { CardChats, LIST_TIMING, type ListTiming } from "./service.ts";

const PAGE = "scope://app/chat.html";
const CHANNELS = ["state", "send", "approve", "stop", "undo-turn"] as const;

/** Tests shorten how long Scope waits for a program's models and how often it asks again. */
function testTiming(): ListTiming {
  const timeout = Number(process.env.SCOPE_TEST_MODEL_LIST_TIMEOUT);
  const cooldown = Number(process.env.SCOPE_TEST_MODEL_LIST_COOLDOWN);
  if (app.isPackaged) return LIST_TIMING;
  return {
    timeout: timeout > 0 ? timeout : LIST_TIMING.timeout,
    cooldown:
      cooldown >= 0 && process.env.SCOPE_TEST_MODEL_LIST_COOLDOWN ? cooldown : LIST_TIMING.cooldown,
  };
}

/**
 * The chat panel runs in its own web view beside the card editor. Published pages share the
 * workspace page, so they can call anything its bridge offers; chat operations are therefore
 * accepted only from this view, whose page and preload Scope alone loads.
 */
export function registerCardChat(
  { window, handle, store, artifacts }: MainPluginContext,
  harnesses: ChatHarness[],
  tools?: CardToolService,
) {
  let view: WebContentsView | undefined;
  let target: ChatTarget | null = null;
  let theme: ChatTheme = "light";
  const saved = artifacts.chats;
  const chats = new CardChats(
    harnesses,
    (changed) => {
      if (sameTarget(changed, target)) publish();
    },
    {
      read: ({ tabId, cardId }) => saved.read(tabId, cardId),
      save: ({ tabId, cardId }, chat) => saved.save(tabId, cardId, chat),
      folderMade: (cardId) => saved.folderMade(cardId),
      goneFolders: () => saved.goneFolders(),
      forgetFolder: (cardId) => saved.forgetFolder(cardId),
    },
    app.getPath("userData"),
    () => store.settings().cardChatProgram,
    tools,
    testTiming(),
  );
  void chats.sweep();

  function publish() {
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send("scope-chat:theme", theme);
      view.webContents.send("scope-chat:state", chats.state(target));
    }
  }

  function create(): WebContentsView {
    const created = new WebContentsView({
      webPreferences: {
        preload: fileURLToPath(new URL("./chat-preload.cjs", import.meta.url)),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-frame-navigate", (event) => {
      if (event.url !== PAGE) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-finish-load", publish);
    created.setVisible(false);
    window.contentView.addChildView(created);
    void contents.loadURL(PAGE);
    return created;
  }

  function place(bounds: ChatBounds | null) {
    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      view?.setVisible(false);
      return;
    }
    view ??= create();
    // Settings may have changed what runs while the panel was hidden behind its dialog.
    const shown = view.getVisible();
    const zoom = window.webContents.getZoomFactor();
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.round(bounds.width * zoom),
      height: Math.round(bounds.height * zoom),
    });
    view.setVisible(true);
    if (!shown) publish();
  }

  // Loading a chat takes a moment; a layout sent meanwhile wins over the one that waited.
  let layouts = 0;
  handle("scope:chat-layout", async (input) => {
    const layout = decode(ChatLayout, input);
    const latest = ++layouts;
    if (layout.closed) chats.leave(layout.target);
    if (!store.settings().cardChatEnabled || window.isDestroyed()) {
      target = null;
      place(null);
      return;
    }
    if (layout.bounds) {
      const moved = !sameTarget(layout.target, target) || layout.theme !== theme;
      if (!sameTarget(layout.target, target)) await chats.load(layout.target);
      if (latest !== layouts) return;
      theme = layout.theme;
      target = layout.target;
      place(layout.bounds);
      if (moved) publish();
    } else if (sameTarget(layout.target, target)) {
      // Showing the card again loads it again, which lets a blocked chat check the login anew.
      target = null;
      place(null);
    }
  });
  // Settings lists each installed program's models. Listing starts the program but sends no message.
  handle("scope:card-chat-programs", (input) => {
    const request = decode(ChatProgramsRequest, input);
    if (!store.settings().cardChatEnabled) throw new Error("Card chat is off in Settings.");
    return chats.programs(request?.refresh === true);
  });
  // A reload or crash of the workspace page drops its editors, so nothing holds room for the panel.
  const hide = () => place(null);
  window.webContents.on("did-start-navigation", hide);
  window.webContents.on("render-process-gone", hide);

  function trusted(event: IpcMainInvokeEvent) {
    const contents = view?.webContents;
    if (
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      event.senderFrame.url !== PAGE
    )
      throw new Error("Untrusted chat caller.");
  }
  function fromChatView(event: IpcMainInvokeEvent) {
    trusted(event);
    if (!store.settings().cardChatEnabled) throw new Error("Card chat is off in Settings.");
    if (!target) throw new Error("Open a card to chat about it.");
    return target;
  }
  function chatHandle(
    name: (typeof CHANNELS)[number],
    action: (target: ChatTarget, input: unknown) => unknown,
  ) {
    ipcMain.handle(`scope-chat:${name}`, async (event, input: unknown) => {
      const current = fromChatView(event);
      try {
        return await action(current, input);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : "Chat could not do that.");
      }
    });
  }
  ipcMain.handle("scope-chat:state", (event) => {
    trusted(event);
    return chats.state(target);
  });
  chatHandle("send", (current, input) => {
    return chats.send(current, decode(ChatSend, input).text);
  });
  chatHandle("approve", (current, input) => {
    const { id, allow } = decode(ChatApprove, input);
    return chats.approve(current, id, allow);
  });
  chatHandle("stop", (current) => chats.stop(current));
  chatHandle("undo-turn", (current, input) =>
    chats.undoTurn(current, decode(ChatUndoTurn, input).turnId),
  );

  return {
    chats,
    removed: (tabIds: readonly string[]) => chats.removed(tabIds),
    dispose() {
      for (const name of CHANNELS) ipcMain.removeHandler(`scope-chat:${name}`);
      window.webContents.removeListener("did-start-navigation", hide);
      window.webContents.removeListener("render-process-gone", hide);
      chats.close();
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    },
  };
}

function sameTarget(a: ChatTarget | null, b: ChatTarget | null) {
  return a?.tabId === b?.tabId && a?.cardId === b?.cardId && a !== null && b !== null;
}
