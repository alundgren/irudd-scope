import { watch, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, ScopeError, decode } from "@irudd-scope/protocol";
import {
  agentNotificationSender,
  readWhenAvailable,
  type AgentNotificationOptions,
} from "./agent-notifications.ts";

export async function watchRetro(
  client: ScopeClient,
  input: string,
  options: AgentNotificationOptions,
  controller: AbortController,
) {
  const name = decode(ArtifactName, input);
  const { signal } = controller;
  const sent = new Set<string>();
  const cwd = process.cwd();
  const directory = watch(cwd, () => {
    if (!existsSync(cwd)) controller.abort();
  });
  directory.on("error", () => controller.abort());
  let checking: Promise<void> | undefined;
  let again = false;
  let artifactId: string | undefined;
  try {
    const send = await agentNotificationSender(options, controller, "retro", name);
    async function check() {
      if (checking) {
        again = true;
        return checking;
      }
      checking = (async () => {
        do {
          again = false;
          const snapshot = await readWhenAvailable(
            () => client.retro({ action: "read", name }),
            signal,
            "Waiting for Scope to become available.",
          );
          if (snapshot.type !== "snapshot") throw new Error("Expected a retrospective snapshot.");
          artifactId = snapshot.snapshot.artifact.id;
          if (snapshot.snapshot.status === "finished") {
            controller.abort();
            return;
          }
          const report = snapshot.snapshot;
          const notices = [
            ...report.decisions.map((d) => ({
              id: `decision:${d.findingId}:${d.at}`,
              text: `Decision ${d.decision} on ${d.findingId}`,
            })),
            ...report.comments.map((c) => ({ id: c.id, text: `Comment ${c.text}` })),
            ...report.requests
              .filter((r) => r.status === "pending")
              .map((r) => ({ id: r.id, text: `Investigation request ${r.text}` })),
          ];
          for (const notice of notices)
            if (!sent.has(notice.id)) {
              await send(
                `Scope retrospective ${name}: ${notice.text}. Run irudd-scope retro read ${name}, read the durable decisions and requests, and continue the operator's existing task. Do not finish until the operator explicitly asks. Use retro guide for the validated contract.`,
              );
              sent.add(notice.id);
            }
        } while (again && !signal.aborted);
      })();
      try {
        await checking;
      } finally {
        checking = undefined;
      }
    }
    await check();
    process.stderr.write(`Listening for retrospective decisions on ${name}.\n`);
    while (!signal.aborted) {
      try {
        await check();
        await client.watch((event) => {
          if (event.type === "deleted" && event.id === artifactId) controller.abort();
          if (event.type === "ready" || (event.type === "retro" && event.name === name)) {
            void check().catch((error: unknown) => {
              process.stderr.write(
                `${error instanceof Error ? error.message : "Retrospective delivery failed."}\n`,
              );
              process.exitCode = 1;
              controller.abort();
            });
          }
        }, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof ScopeError && ![409, 502, 503, 504].includes(error.status))
          throw error;
        process.stderr.write(
          `Retrospective listener reconnecting: ${error instanceof Error ? error.message : "connection ended"}\n`,
        );
        await delay(1000, undefined, { signal }).catch(() => {});
      }
    }
    await checking;
  } finally {
    directory.close();
  }
}
