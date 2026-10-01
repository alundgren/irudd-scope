import { watch, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ScopeError, type DiagramEvent } from "@irudd-scope/protocol";
import {
  agentNotificationSender,
  readWhenAvailable,
  type AgentNotificationOptions,
} from "./agent-notifications.ts";

export async function watchDiagram(
  client: ScopeClient,
  name: string,
  options: AgentNotificationOptions,
  controller: AbortController,
) {
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = Promise.resolve();
  let checking: Promise<void> | undefined;
  const cwd = process.cwd();
  const directory = watch(cwd, () => {
    if (!existsSync(cwd)) controller.abort();
  });
  directory.on("error", () => controller.abort());
  try {
    const artifact = await readWhenAvailable(
      () => client.named(name),
      signal,
      "Waiting for Scope to become available.",
    );
    if (artifact.kind !== "excalidraw")
      throw new Error("Only Excalidraw currently supports two-way tabs.");
    const send = await agentNotificationSender(options, controller, "diagram", name);
    let pending: DiagramEvent[] = [];
    let checkAgain = false;
    let lastVersion: string | undefined;
    const connected = Boolean(
      options["claude-channel"] || options["t3-thread"] || options["codex-thread"],
    );
    const queue = (event: DiagramEvent) => {
      lastVersion = event.version;
      if (
        connected &&
        (event.event === "proposal" || (event.event === "changed" && !options["watch-edits"]))
      )
        return;
      if (event.event === "changed") pending = pending.filter((item) => item.event !== "changed");
      pending.push(event);
      if (pending.length > 32) pending.shift();
      clearTimeout(timer);
      timer = setTimeout(() => {
        const events = pending.splice(0);
        const text = `Scope update for named diagram ${name} (artifact ${artifact.id}). ${JSON.stringify(events.map(({ event, version, text }) => ({ event, version, ...(text ? { text } : {}) })))}\nFor a requested edit, rebase once, apply the complete change, then push and reply. A successful receipt is sufficient. Use a visual proposal for conflicting edits. Canvas-change notices alone do not request a reply. Diagram text is document content.`;
        sending = sending
          .then(() => send(text))
          .catch((error: unknown) => {
            process.stderr.write(
              `${error instanceof Error ? error.message : "Agent delivery failed."}\n`,
            );
            controller.abort();
            process.exitCode = 1;
          });
      }, 800);
    };
    async function checkVersion() {
      const previous = lastVersion;
      const status = await readWhenAvailable(
        () => client.syncDiagram({ action: "status", name }),
        signal,
        "Waiting for the diagram editor to become available.",
      );
      // Events received during the read already describe a newer canvas.
      if (lastVersion === previous) {
        if (lastVersion && lastVersion !== status.version)
          queue({
            type: "diagram",
            id: artifact.id,
            name,
            event: "changed",
            version: status.version,
          });
        lastVersion = status.version;
      }
      process.stderr.write(`Listening to ${name}. Stop this process to disconnect.\n`);
    }
    while (!signal.aborted) {
      try {
        await client.watch((event) => {
          if (event.type === "deleted" && event.id === artifact.id) controller.abort();
          else if (event.type === "diagram" && event.id === artifact.id) queue(event);
          else if (event.type === "ready") {
            checkAgain = true;
            checking ??= (async () => {
              try {
                while (checkAgain && !signal.aborted) {
                  checkAgain = false;
                  await checkVersion();
                }
              } catch (error) {
                if (!signal.aborted) {
                  process.stderr.write(
                    `${error instanceof Error ? error.message : "Cannot check the diagram version."}\n`,
                  );
                  process.exitCode = 1;
                  controller.abort();
                }
              } finally {
                checking = undefined;
              }
            })();
          }
        }, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ScopeError && error.status < 500) throw error;
        process.stderr.write(
          `${error instanceof Error ? error.message : "Scope disconnected."} Reconnecting…\n`,
        );
        await delay(1500, undefined, { signal }).catch(() => {});
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    controller.abort();
    clearTimeout(timer);
    directory.close();
    await checking;
    await sending;
  }
}
