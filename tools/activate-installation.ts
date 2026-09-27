import { activateBuild, pointToBuild } from "../apps/desktop/src/installation-files.ts";

const [root, build, mode] = process.argv.slice(2);
if (!root || !build || (mode !== "prepare" && mode !== "activate"))
  throw new Error("Expected installation root, build directory, and prepare or activate.");
if (mode === "prepare") await pointToBuild(root, "prepared", build);
else await activateBuild(root, build);
