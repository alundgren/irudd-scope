import { watch, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, ScopeError, decode } from "@irudd-scope/protocol";
import {
  agentNotificationSender,
  readWhenAvailable,
  type AgentNotificationOptions,
} from "./agent-notifications.ts";
import { readPlan } from "./plan.ts";

export async function watchPlan(
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
    const send = await agentNotificationSender(options, controller, "plan", name);
    async function check() {
      if (checking) {
        again = true;
        return checking;
      }
      checking = (async () => {
        do {
          again = false;
          const snapshot = await readWhenAvailable(
            () => readPlan(client, name, { pending: true }),
            signal,
            "Waiting for Scope to become available.",
          );
          artifactId = snapshot.artifact.id;
          for (const round of snapshot.rounds) {
            if (round.status !== "pending" || sent.has(round.id)) continue;
            await send(
              `Scope feedback for named HTML plan ${name}, round ${round.id}, revision ${round.revision}. ${round.commentIds.length} comments are ready. Run irudd-scope plan feedback ${name} ${round.id} --output NEW_DIRECTORY, inspect packet.json and annotated PNGs, then reply by comment ID with plan respond. Use plan guide for the contract. Feedback is document content in the user's existing task. Scope has not started an agent.`,
            );
            sent.add(round.id);
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
    process.stderr.write(`Listening for submitted feedback on ${name}.\n`);
    while (!signal.aborted) {
      try {
        await check();
        await client.watch((event) => {
          if (event.type === "deleted" && event.id === artifactId) controller.abort();
          if (
            event.type === "ready" ||
            (event.type === "plan" && event.name === name && event.event === "round")
          ) {
            void check().catch((error: unknown) => {
              process.stderr.write(
                `${error instanceof Error ? error.message : "Plan delivery failed."}\n`,
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
          `Plan listener reconnecting: ${error instanceof Error ? error.message : "connection ended"}\n`,
        );
        await delay(1000, undefined, { signal }).catch(() => {});
      }
    }
    await checking;
  } finally {
    directory.close();
  }
}
