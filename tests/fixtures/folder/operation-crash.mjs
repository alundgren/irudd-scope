import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Fault injection runs only in synthetic hub/writer subprocesses.
const originalNow = Date.now;
Date.now = () =>
  originalNow() + Number(fs.readFileSync(process.env.SCOPE_FOLDER_TEST_CLOCK, "utf8"));
for (const name of ["renameSync", "linkSync"]) {
  const original = fs[name];
  fs[name] = (...args) => {
    const result = original(...args);
    if (
      String(args[1]).endsWith("/crash-after-commit.txt") &&
      fs.existsSync(process.env.SCOPE_FOLDER_TEST_CRASH)
    ) {
      fs.unlinkSync(process.env.SCOPE_FOLDER_TEST_CRASH);
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  };
}
syncBuiltinESMExports();
