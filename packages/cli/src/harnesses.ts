import type { ScopeClient } from "@irudd-scope/protocol/client";

/** Runs a harnesses command. This Scope reads only the desktop's own computer. */
export async function harnessesCommand(
  connect: () => Promise<ScopeClient>,
  action: string | undefined,
  machine: string | undefined,
) {
  if (action !== "scan" && action !== "read")
    throw new Error("Use harnesses guide, scan, or read [--machine local].");
  if ((machine ?? "local") !== "local")
    throw new Error(`Unknown machine ${machine}. Use --machine local.`);
  const client = await connect();
  return action === "scan" ? client.scanHarnesses("local") : client.harnesses("local");
}
