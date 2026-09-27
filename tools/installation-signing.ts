import { isAbsolute } from "node:path";
import { readSigningIdentity } from "../apps/desktop/src/installation-files.ts";

const [root] = process.argv.slice(2);
if (!root || !isAbsolute(root)) throw new Error("Expected an absolute installation root.");
console.log((await readSigningIdentity(root, process.env.SCOPE_SIGNING_IDENTITY)) ?? "-");
