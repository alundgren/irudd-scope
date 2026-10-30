import { homedir } from "node:os";
import { decode } from "@irudd-scope/protocol";
import { readSessionsInProcess } from "@irudd-scope/sessions";
import type { MainPluginContext } from "../main-api.ts";
import { SessionsReadRequest } from "./contract.ts";

/** Each read runs in its own process. A newer read stops the one before it. */
export function registerSessionsIpc({ handle }: Pick<MainPluginContext, "handle">) {
  let current: AbortController | null = null;
  handle("scope:sessions-read", async (input) => {
    const { days } = decode(SessionsReadRequest, input);
    current?.abort();
    const controller = new AbortController();
    current = controller;
    try {
      return await readSessionsInProcess({ home: homedir(), days, signal: controller.signal });
    } finally {
      if (current === controller) current = null;
    }
  });
  return { dispose: () => current?.abort() };
}
