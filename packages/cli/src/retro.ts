import { readFile, stat } from "node:fs/promises";
import { Schema } from "effect";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { RetroCommand, MAX_RETRO_REQUEST_BYTES } from "@irudd-scope/protocol/retro";

export const RetroGuide = {
  create:
    "Publish trusted HTML using add report.html --retro --name retro-NAME. Updates preserve review decisions and authored state. Retrospectives start permanent.",
  workflow:
    "The operator starts their existing agent and asks for a Scope retro. Scope never executes SSH, filesystem, Git or model operations. Agents inspect native logs externally, then submit normalized metadata and findings. Use retro settings and tracking to read the machine running Scope, its paired remotes, repositories and prior audited native session IDs. Sources appear automatically; never ask the operator to add them. Source location identifies the desktop hostname or paired remote ID and endpoint. Resolve each machine through existing agent access; a remote with null sshAlias is not local to the agent, and an HTTPS endpoint is not an SSH alias. Mark inaccessible machines unavailable. Ignore current and recorded retro-agent IDs. Runtime roots and any saved SSH aliases are access hints, not commands for Scope to execute.",
  firstUse:
    "Offer No/start from now, Check/count first, or Yes/review all. Check only reads tracking and external discovery. Stage initialization all or from-now with the discovery timestamp in available source coverage. Even empty discovery initializes only when the operator tells the agent to finish. Failed and unavailable runtimes never initialize. Recommend postponing unavailable selected sources; record explicit operator override to finish without them.",
  writes:
    "Use retro apply FILE.json with the exact validated schema. Every report mutation needs name, tabId, expectedVersion from the current report, and a stable UUID requestId. State writes use appState.version. Retry uncertain writes with identical payload and requestId. Conflicts require reading and reconciling. Publish replaces report findings and metrics; inventory upserts at most 200 sessions per request. Repeated read pages require the same version and next cursor. Native timestamps may be null; do not invent usage or dates. Metrics distinguish exact, estimated and unknown with method, coverage and evidence.",
  proposals:
    "Memory is off by default. Proposals require a permitted, available destination that exactly matches a verified configured capability. Distinguish operator and project destinations. Acceptance records a decision only. Scope writes no destination files. Decided proposals cannot silently change on later publication; use a new finding for reconsideration. Human edits save exact text and optional destination. Agents apply accepted corrections with their existing tools and record applied, failed or declined outcomes with evidence.",
  finish:
    "Only the agent can finish, after explicit operator text. Resolve investigation requests and record all accepted correction outcomes first. Finish freezes HTML, report and authored state, saves history, initializes available runtime coverage and marks reviewed IDs in one scope.db transaction. Interrupted work commits no reviewed IDs or initialization. Deleted history preserves tracking and configuration. Finished reports have no resume operation.",
  watch:
    "retro watch NAME uses the existing agent-notifications adapters. Without a host destination it only prints notices; use the report's Copy agent request fallback. The listener stops on finish or deletion. Scope never launches an agent.",
  schema: Schema.toJsonSchemaDocument(RetroCommand, { onExcessProperty: "error" }).schema,
};

export async function retroCommand(
  client: ScopeClient,
  positionals: string[],
  signal: AbortSignal,
) {
  const [, action, argument] = positionals;
  if (action === "apply") {
    if (!argument) throw new Error("Provide a retrospective command JSON file.");
    if ((await stat(argument)).size > MAX_RETRO_REQUEST_BYTES)
      throw new Error("Retrospective command exceeds 2 MiB.");
    return client.retro(
      decode(RetroCommand, JSON.parse(await readFile(argument, { encoding: "utf8", signal }))),
    );
  }
  if (action === "settings" || action === "history") return client.retro({ action });
  if (action === "read" && argument)
    return client.retro({ action, name: decode(ArtifactName, argument) });
  throw new Error("Use retro guide, settings, read, apply, history, or watch.");
}
