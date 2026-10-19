import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LoadHook } from "node:module";
import { transformWithOxc } from "vite-plus";

export const load: LoadHook = async (url, context, nextLoad) => {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const result = await transformWithOxc(
    await readFile(fileURLToPath(url), "utf8"),
    fileURLToPath(url),
    { lang: "ts" },
  );
  return { format: "module", source: result.code, shortCircuit: true };
};
