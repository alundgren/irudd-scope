import { contextBridge, ipcRenderer } from "electron";
import type { ChatState, ChatTheme, ScopeChatBridge } from "./contract.ts";

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const receive = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const bridge: ScopeChatBridge = {
  state: () => ipcRenderer.invoke("scope-chat:state"),
  send: (input) => ipcRenderer.invoke("scope-chat:send", input),
  approve: (input) => ipcRenderer.invoke("scope-chat:approve", input),
  stop: () => ipcRenderer.invoke("scope-chat:stop"),
  undoTurn: (input) => ipcRenderer.invoke("scope-chat:undo-turn", input),
  onState: (listener) => subscribe<ChatState>("scope-chat:state", listener),
  onTheme: (listener) => subscribe<ChatTheme>("scope-chat:theme", listener),
};
contextBridge.exposeInMainWorld("scopeChat", bridge);
