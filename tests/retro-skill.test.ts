import { test, expect } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const exec = promisify(execFile);

test("public retro helper inspects synthetic native histories and destination capabilities", async () => {
  const result = await exec(
    "python3",
    [
      "-m",
      "unittest",
      "discover",
      "-s",
      resolve(".agents/skills/irudd-scope-retro/tests"),
      "-p",
      "test_*.py",
    ],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
  );
  expect(result.stderr).toContain("OK");
});
