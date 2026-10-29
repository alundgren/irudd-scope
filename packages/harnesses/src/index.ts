import type { HarnessScan } from "@irudd-scope/protocol/harnesses";
import { fitScan } from "./fit.ts";
import { scanHarnesses, scanSharedSkills } from "./scan.ts";
import { measureFolder } from "./size.ts";

export { readHarnessFile, type HarnessFileOptions } from "./file.ts";

export type HarnessScanOptions = {
  /** The account's home folder: `HOME` on macOS and Linux, `%USERPROFILE%` on Windows. */
  home: string;
  /** PATH for finding harness binaries, including folders a GUI launch omits. */
  path: string;
  /** Stops a running `--version` call, for example when Scope quits. */
  signal: AbortSignal;
};

export type HarnessScanRun = {
  /** Every fact, validated, with each found harness's size pending. */
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
  const scan = fitScan({
    machine: "local",
    scannedAt,
    harnesses: targets.map((target) => target.report),
    sharedSkills,
  });
  return {
    scan,
    sizes: async (signal) => {
      const harnesses = [];
      for (const [index, target] of targets.entries()) {
        const report = scan.harnesses[index]!;
        harnesses.push(
          target.root ? { ...report, size: await measureFolder(target.root, signal) } : report,
        );
      }
      return fitScan({ ...scan, harnesses });
    },
  };
}
