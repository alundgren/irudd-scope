import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export async function syntheticCli(directory: string, name: string, source: string) {
  if (process.platform !== "win32") {
    const binary = join(directory, name);
    await writeFile(binary, "#!" + process.execPath + "\n" + source);
    await chmod(binary, 0o700);
    return binary;
  }
  // A native single-process executable supports discovery and process cleanup.
  // Failure to build it aborts setup before an installed CLI can be selected.
  const main = join(directory, name + ".cjs");
  const binary = join(directory, name + ".exe");
  const config = join(directory, name + "-sea.json");
  await writeFile(main, source);
  await writeFile(
    config,
    JSON.stringify({ main, output: binary, disableExperimentalSEAWarning: true }),
  );
  await promisify(execFile)(process.execPath, ["--build-sea", config], {
    timeout: 30000,
    windowsHide: true,
  });
  return binary;
}
