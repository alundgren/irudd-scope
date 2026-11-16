import { delimiter, join } from "node:path";
import { findOnPath } from "./version.ts";

/**
 * Finds a harness program by name the way the scan does: `~/.local/bin/<name>` first, then
 * PATH. It only looks; it never runs the program. A name with a path in it finds nothing.
 */
export async function findProgram(
  name: string,
  home: string,
  path: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return findOnPath(name, [join(home, ".local", "bin"), path].filter(Boolean).join(delimiter));
}
