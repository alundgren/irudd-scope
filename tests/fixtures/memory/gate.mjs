import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

export async function commandGate(name, args) {
  const command = `${name}:${args.join(" ")}`;
  if (process.env.FAKE_MEMORY_LOG) appendFileSync(process.env.FAKE_MEMORY_LOG, `${command}\n`);
  const marker = process.env.FAKE_MEMORY_GATE;
  if (!marker || !command.startsWith(process.env.FAKE_MEMORY_PAUSE ?? "\0") || existsSync(marker))
    return;
  writeFileSync(marker, command);
  while (!existsSync(`${marker}.continue`)) await setTimeout(10);
}
