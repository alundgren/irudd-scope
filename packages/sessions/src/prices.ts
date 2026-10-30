import { readFile } from "node:fs/promises";
import type { SessionTokens } from "./contract.ts";
import { num, parseJson, record } from "./text.ts";

type Rate = { input: number; read: number; write5m: number; write1h: number; output: number };

/**
 * List prices per token from T3's own price file. A model without a price costs nothing
 * here and the tab says the cost is unknown for it.
 */
export async function readPrices(file: string) {
  const document = record(parseJson(await readFile(file, "utf8").catch(() => "")).document);
  const rates = new Map<string, Rate>();
  for (const [model, value] of Object.entries(document)) {
    const r = record(value);
    rates.set(model, {
      input: num(r.input_cost_per_token),
      read: num(r.cache_read_input_token_cost),
      write5m: num(r.cache_creation_input_token_cost),
      write1h:
        num(r.cache_creation_input_token_cost_above_1hr) || num(r.cache_creation_input_token_cost),
      output: num(r.output_cost_per_token),
    });
  }
  return (model: string | null, tokens: SessionTokens): number | null => {
    if (!model) return null;
    const rate = rates.get(model) ?? rates.get(model.split("[")[0]!);
    if (!rate) return null;
    return (
      tokens.uncached * rate.input +
      tokens.cacheRead * rate.read +
      tokens.cacheWrite5m * rate.write5m +
      tokens.cacheWrite1h * rate.write1h +
      tokens.output * rate.output
    );
  };
}

export type Prices = Awaited<ReturnType<typeof readPrices>>;
