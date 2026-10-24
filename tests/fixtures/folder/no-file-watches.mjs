// Preloaded into a spawned hub to act like a Linux machine that has run out of file watches.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.watch = () => {
  throw Object.assign(new Error("No file watches are left."), { code: "ENOSPC" });
};
syncBuiltinESMExports();
