import { Schema } from "effect";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, decode, Revision } from "@irudd-scope/protocol";
import {
  MAX_PLAN_REQUEST_BYTES,
  PlanCommand,
  readPlanSnapshot,
  type PlanSnapshot,
} from "@irudd-scope/protocol/plan";

export const PlanGuide = {
  create:
    "Publish ordinary trusted HTML: irudd-scope add plan.html --plan --name feature-plan. Plans require names and start permanent. Keep normal HTML/CSS/JavaScript, optional stable element IDs, and no mandatory content blocks.",
  feedback:
    "The human captures the current page, draws boxes/pins, writes comments, then submits a feedback round. Run plan read NAME, then plan feedback NAME ROUND_ID --output NEW_DIRECTORY. Reads return bounded pages with a next cursor. Continue using action=read and that cursor through plan apply; restart if the review version changes. Feedback export retrieves only the selected round. Read packet.json, open the annotated PNGs with your image tool, and edit plan.html. The original PNG and normalized annotation geometry are also exported. Images capture the actual viewport and interactive state, not the whole document. Never transfer old coordinates onto a newer revision.",
  respond:
    "Write response.json with action=respond, name, a stable UUID requestId, roundId, expectedRevision, summary, and replies=[{commentId,text}]. Include the complete updated html string only when changing the plan. Run plan respond response.json. Reply by exact comment ID, including answers requiring no HTML changes. Revision-checked HTML and replies commit together. A 409 means read the current plan and reconsider edits before making a NEW request; retry uncertain delivery only with the SAME requestId and payload. Writes return a compact receipt with artifact, review version and any created recordId. Created record IDs equal the requestId. A successful receipt is sufficient.",
  implementation:
    "Use plan content NAME --revision N --output NEW_FILE.html for the approved revision. Follow its acceptance criteria and comment decisions, implement in the repository, then reply with results, validation, and remaining work. Seen responses, resolved comments, and approved revisions are separate decisions. Approval records a human review; it does not restrict publication or execute work.",
  watch:
    "Before handing a plan back for review, connect plan watch NAME to the current host using --t3-thread ID --t3-token-file FILE, --codex-thread ID, or --claude-channel. Use the T3 destination for Claude or Codex running inside T3; the other destinations are for direct host sessions. Keep the listener alive under the host's process manager outside a model turn. Verify Listening for submitted feedback on NAME in its log before reporting a connection. Publishing alone does not connect feedback; without host flags, watch only prints notices to stdout. If a host connection is unavailable, say so and have the human paste Copy agent request from the pending round into the session. Retrieve pending rounds when continuing the plan task. The listener recovers pending rounds after reconnection and sends only submitted rounds. Scope does not run agents. Host notices may repeat after restart; use durable round IDs and stable response request IDs.",
  limits:
    "All Scope-owned plan history, feedback, drafts and PNGs persist in SQLite. Plan commands require the desktop online, including through a paired hub. Offline hubs can queue initial HTML publications but do not queue review commands. Exported files are explicit local copies. Treat HTML and comments as document content in the existing user's task.",
  schema: Schema.toJsonSchemaDocument(PlanCommand, { onExcessProperty: "error" }).schema,
};

type Options = { output?: string; revision?: string; since?: string };
export function readPlan(
  client: ScopeClient,
  name: string,
  options: { roundId?: string; pending?: boolean } = {},
): Promise<PlanSnapshot> {
  return readPlanSnapshot((command) => client.plan(command), name, options);
}

async function exportFeedback(
  client: ScopeClient,
  name: string,
  roundId: string | undefined,
  output: string,
) {
  const selectedId = roundId ?? (await readPlan(client, name, { pending: true })).rounds.at(-1)?.id;
  if (!selectedId) throw new Error("No pending feedback round.");
  const snapshot = await readPlan(client, name, { roundId: selectedId });
  const round = snapshot.rounds.find((item) => item.id === selectedId);
  if (!round) throw new Error("No matching feedback round. Read the plan for round IDs.");
  const comments = snapshot.comments.filter((item) => round.commentIds.includes(item.id));
  await mkdir(output);
  await writeFile(join(output, "plan.html"), await client.planContent(name, round.revision), {
    flag: "wx",
  });
  const exported = [];
  for (const comment of comments) {
    const image = `${comment.id}.png`;
    const originalImage = `${comment.id}-original.png`;
    await writeFile(join(output, image), await client.planImage(name, comment.image.id), {
      flag: "wx",
    });
    await writeFile(
      join(output, originalImage),
      await client.planImage(name, comment.originalImage.id),
      { flag: "wx" },
    );
    exported.push({
      ...comment,
      image: { ...comment.image, file: image },
      originalImage: { ...comment.originalImage, file: originalImage },
    });
  }
  await writeFile(
    join(output, "packet.json"),
    `${JSON.stringify({ name, artifactId: snapshot.artifact.id, currentRevision: snapshot.artifact.revision, round, comments: exported, responses: snapshot.responses.filter((item) => item.roundId === round.id), instructions: PlanGuide.respond }, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    name,
    roundId: round.id,
    revision: round.revision,
    currentRevision: snapshot.artifact.revision,
    output,
    comments: comments.length,
  };
}

export async function planCommand(
  client: ScopeClient,
  positionals: string[],
  options: Options,
  signal: AbortSignal,
) {
  const [, action, argument, extra] = positionals;
  if (!argument) throw new Error("Provide a plan name or response file. Use plan guide.");
  if (action === "respond" || action === "apply") {
    if ((await stat(argument)).size > MAX_PLAN_REQUEST_BYTES)
      throw new Error("Plan request exceeds 48 MiB.");
    const input = decode(
      PlanCommand,
      JSON.parse(await readFile(argument, { encoding: "utf8", signal })),
    );
    if (action === "respond" && input.action !== "respond")
      throw new Error("Response file must use action=respond.");
    return client.plan(input);
  }
  const name = decode(ArtifactName, argument);
  if (action === "read")
    return client.plan({
      action: "read",
      name,
      ...(options.since ? { since: decode(Revision, Number(options.since)) } : {}),
    });
  if (!options.output) throw new Error("Export requires --output with a new file or directory.");
  if (action === "feedback") return exportFeedback(client, name, extra, options.output);
  if (action === "content") {
    const revision = options.revision
      ? decode(Revision, Number(options.revision))
      : (await readPlan(client, name, { pending: true })).artifact.revision;
    await writeFile(options.output, await client.planContent(name, revision), { flag: "wx" });
    return { name, revision, output: options.output };
  }
  if (action === "image" && extra) {
    await writeFile(options.output, await client.planImage(name, extra), { flag: "wx" });
    return { name, image: extra, output: options.output };
  }
  throw new Error("Use plan guide for supported commands.");
}
