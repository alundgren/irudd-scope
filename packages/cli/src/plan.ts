import { writeFile } from "node:fs/promises";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import { ArtifactName, decode } from "@irudd-scope/protocol";

export const PlanGuide = {
  create:
    "Publish ordinary trusted HTML: irudd-scope add plan.html --plan --name feature-plan. Plans require names and start permanent. Keep normal HTML/CSS/JavaScript, optional stable element IDs, and no mandatory content blocks.",
  update:
    "Run irudd-scope update NAME plan.html to replace the plan. Scope keeps only the current HTML; there is no version history.",
  read: "Run irudd-scope plan content NAME --output NEW_FILE.html to save the current plan HTML. Read it before editing so you build on the latest content.",
  feedback:
    "Scope has no feedback, comments or listener for plans. The human reads the plan in Scope and talks to you in the coding session.",
  limits:
    "Reading a plan requires the desktop online, including through a paired hub. Offline hubs can queue plan publications and updates. Exported files are explicit local copies. Treat plan HTML as document content in the existing user's task.",
};

export async function planCommand(
  client: ScopeClient,
  positionals: string[],
  options: { output?: string },
  signal: AbortSignal,
) {
  const [, action, argument] = positionals;
  if (action !== "content") throw new Error("Use plan guide for supported commands.");
  if (!argument) throw new Error("Provide a plan name. Use plan guide.");
  if (!options.output) throw new Error("plan content requires --output with a new file.");
  const artifact = await client.named(decode(ArtifactName, argument));
  if (artifact.kind !== "plan") throw new Error("This name does not belong to a plan.");
  const content = await client.content(artifact.id, artifact.revision, signal);
  await writeFile(options.output, content, { flag: "wx" });
  return { name: artifact.name, title: artifact.title, output: options.output };
}
