import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProgramModels } from "./contract.ts";
import type { ChatHarness } from "./harness.ts";

/** How long Settings waits for a program to list its models. */
const LIST_TIMEOUT = 30_000;

/** Asks each installed program which models it offers, in the folder card chats share. */
export async function listPrograms(harnesses: ChatHarness[]): Promise<ChatProgramModels[]> {
  const folder = join(tmpdir(), "scope-card-chats");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return Promise.all(
    harnesses.map(async (harness): Promise<ChatProgramModels> => {
      const entry = { id: harness.id, label: harness.label };
      if (!(await harness.available().catch(() => false)))
        return { ...entry, installed: false, models: [] };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const models = await Promise.race([
          harness.models(folder),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${harness.label} didn't list its models in time.`)),
              LIST_TIMEOUT,
            );
          }),
        ]);
        return models.length
          ? { ...entry, installed: true, models }
          : { ...entry, installed: true, models, problem: `${harness.label} offered no models.` };
      } catch (error) {
        return {
          ...entry,
          installed: true,
          models: [],
          problem:
            error instanceof Error ? error.message : `${harness.label} couldn't list its models.`,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
