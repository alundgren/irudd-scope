import type { HarnessScan } from "@irudd-scope/protocol/harnesses";
import { scanHarnesses, scanSharedSkills } from "./scan.ts";
import { measureFolder } from "./size.ts";

export type HarnessScanOptions = {
  /** The account's home folder: `HOME` on macOS and Linux, `%USERPROFILE%` on Windows. */
  home: string;
  /** PATH for finding harness binaries, including folders a GUI launch omits. */
  path: string;
};

export type HarnessScanRun = {
  /** Every fact, with each found harness's size pending. */
  scan: HarnessScan;
  /**
   * Counts folder sizes in the background and resolves with the completed scan. Rejects when
   * the signal aborts.
   */
  sizes: (signal: AbortSignal) => Promise<HarnessScan>;
};

/** Scans this machine's harnesses without writing anything. */
export async function scanMachine(options: HarnessScanOptions): Promise<HarnessScanRun> {
  const scannedAt = new Date().toISOString();
  const [targets, sharedSkills] = await Promise.all([
    scanHarnesses(options),
    scanSharedSkills(options.home),
  ]);
  const scan: HarnessScan = {
    machine: "local",
    scannedAt,
    harnesses: targets.map((target) => target.report),
    sharedSkills,
  };
  return {
    scan,
    sizes: async (signal) => {
      const harnesses = [];
      for (const target of targets) {
        if (!target.report.found) {
          harnesses.push(target.report);
          continue;
        }
        const size = await measureFolder(target.root, signal);
        harnesses.push({ ...target.report, size });
      }
      return { ...scan, harnesses };
    },
  };
}
