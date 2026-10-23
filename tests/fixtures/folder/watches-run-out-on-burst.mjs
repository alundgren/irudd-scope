// Preloaded into a spawned hub: a new folder named `burst` arrives as a lost watch event
// (no file name), and watching it fails as if the machine had run out of file watches.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const watch = fs.watch;
fs.watch = function (path, ...args) {
  if (String(path).endsWith("/burst"))
    throw Object.assign(new Error("No file watches are left."), { code: "ENOSPC" });
  const index = args.findIndex((argument) => typeof argument === "function");
  if (index >= 0) {
    const listener = args[index];
    args[index] = (type, name) => listener(type, String(name) === "burst" ? null : name);
  }
  return watch.call(this, path, ...args);
};
syncBuiltinESMExports();
