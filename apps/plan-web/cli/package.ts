import { chmod, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../dist/cli", import.meta.url), { recursive: true });
await copyFile(
  new URL("./package.json", import.meta.url),
  new URL("../dist/cli/package.json", import.meta.url),
);
await chmod(new URL("../dist/cli/main.mjs", import.meta.url), 0o755);
for (const [source, target] of [
  ["../../../LICENSE", "LICENSE"],
  ["../node_modules/@modelcontextprotocol/server/LICENSE", "LICENSE-MCP"],
  ["../node_modules/zod/LICENSE", "LICENSE-ZOD"],
]) {
  await copyFile(
    new URL(source, import.meta.url),
    new URL(`../dist/cli/${target}`, import.meta.url),
  );
}
const packed = spawnSync("vp", ["pm", "pack", "--out", "../plan-web-cli-0.1.0.tgz"], {
  cwd: `${app}/dist/cli`,
  stdio: "inherit",
});
if (packed.status !== 0) process.exitCode = packed.status ?? 1;
