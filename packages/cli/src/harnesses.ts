import type { ScopeClient } from "@irudd-scope/protocol/client";
import { HarnessFileOwner } from "@irudd-scope/protocol/harnesses";
import { Schema } from "effect";

const USAGE =
  "Use harnesses guide, scan, read [--machine local], or file [--machine local] HARNESS PATH.";

/** Runs a harnesses command. This Scope reads only the desktop's own computer. */
export async function harnessesCommand(
  connect: () => Promise<ScopeClient>,
  positionals: string[],
  machine: string | undefined,
) {
  const [, action, ...names] = positionals;
  if (action !== "scan" && action !== "read" && action !== "file") throw new Error(USAGE);
  if ((machine ?? "local") !== "local")
    throw new Error(`Unknown machine ${machine}. Use --machine local.`);
  if (action === "file") return fileCommand(connect, names);
  const client = await connect();
  return action === "scan" ? client.scanHarnesses("local") : client.harnesses("local");
}

async function fileCommand(connect: () => Promise<ScopeClient>, names: string[]) {
  const [harness, path, ...extra] = names;
  if (!harness || !path || extra.length) throw new Error(USAGE);
  if (!Schema.is(HarnessFileOwner)(harness))
    throw new Error(`Unknown harness ${harness}. Use codex, claude-code, cursor, grok or shared.`);
  return (await connect()).harnessFile({ machine: "local", harness, path });
}
