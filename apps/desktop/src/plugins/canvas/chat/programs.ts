import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProgramModels } from "./contract.ts";
import type { ChatHarness } from "./harness.ts";

/**
 * Asks one program which models it offers, in the folder card chats share. A program that
 * doesn't answer within `timeout` is stopped with everything it started. Aborting `closing`
 * stops it too and fails the request, because Scope is quitting.
 */
export async function listProgram(
  harness: ChatHarness,
  timeout: number,
  closing: AbortSignal,
): Promise<ChatProgramModels> {
  const entry = { id: harness.id, label: harness.label };
  if (!(await harness.available().catch(() => false)))
    return { ...entry, installed: false, models: [] };
  const folder = join(tmpdir(), "scope-card-chats");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const late = AbortSignal.timeout(timeout);
  try {
    const models = await harness.models(folder, AbortSignal.any([closing, late]));
    return models.length
      ? { ...entry, installed: true, models }
      : { ...entry, installed: true, models, problem: `${harness.label} offered no models.` };
  } catch (error) {
    if (closing.aborted) throw error;
    return {
      ...entry,
      installed: true,
      models: [],
      problem: late.aborted
        ? `${harness.label} didn't list its models in time.`
        : error instanceof Error
          ? error.message
          : `${harness.label} couldn't list its models.`,
    };
  }
}
