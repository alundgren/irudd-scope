import { decode } from "@irudd-scope/protocol";
import { HarnessScan, MAX_HARNESS_SCAN_BYTES } from "@irudd-scope/protocol/harnesses";

/** Room kept in a scan with pending sizes for the sizes that replace them. */
const SIZE_RESERVE_BYTES = 8 * 1024;

type List = { harness: number | null; key: "skills" | "agents" | "mcpServers"; length: number };

/**
 * Validates a scan and shortens its longest lists, marking their reports truncated, until its
 * JSON fits. A scan with pending sizes keeps room for the finished sizes.
 */
export function fitScan(scan: HarnessScan): HarnessScan {
  const pending = scan.harnesses.some((report) => report.size?.state === "pending");
  const limit = MAX_HARNESS_SCAN_BYTES - (pending ? SIZE_RESERVE_BYTES : 0);
  let current = scan;
  while (Buffer.byteLength(JSON.stringify(current)) > limit) {
    const longest = lists(current).reduce((left, right) =>
      right.length > left.length ? right : left,
    );
    if (longest.length === 0) break;
    current = shorten(current, longest, Math.floor((longest.length * 3) / 4));
  }
  return decode(HarnessScan, current);
}

function lists(scan: HarnessScan): List[] {
  return [
    { harness: null, key: "skills", length: scan.sharedSkills.skills.length },
    ...scan.harnesses.flatMap((report, harness) =>
      (["skills", "agents", "mcpServers"] as const).map((key) => ({
        harness,
        key,
        length: report[key].length,
      })),
    ),
  ];
}

function shorten(scan: HarnessScan, list: List, keep: number): HarnessScan {
  if (list.harness === null)
    return {
      ...scan,
      sharedSkills: {
        ...scan.sharedSkills,
        skills: scan.sharedSkills.skills.slice(0, keep),
        truncated: true,
      },
    };
  return {
    ...scan,
    harnesses: scan.harnesses.map((report, index) =>
      index === list.harness
        ? { ...report, [list.key]: report[list.key].slice(0, keep), truncated: true }
        : report,
    ),
  };
}
