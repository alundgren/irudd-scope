import { startHub } from "./server.ts";
import { startPairedHub } from "./paired-server.ts";
import { HubState } from "./state.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONNECTION_FILE } from "@irudd-scope/protocol";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    endpoint: { type: "string" },
    port: { type: "string" },
  },
});
if (
  positionals.length > 1 ||
  (positionals[0] && !["configure", "info", "run"].includes(positionals[0]))
)
  throw new Error("Use configure, info, or run for the hub executable.");
const state =
  process.env.SCOPE_ENDPOINT && !positionals.length
    ? undefined
    : await HubState.open(
        process.env.SCOPE_HUB_DATA_DIR ?? join(homedir(), ".local/share/irudd-scope/hub"),
      );
if (positionals[0] === "configure") {
  try {
    await state!.configure({
      endpoint: values.endpoint ?? "",
      port: Number(values.port ?? "43120"),
      connectionFile: resolve(
        process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE),
      ),
    });
    console.log("Hub configured.");
  } finally {
    state!.close();
  }
} else if (positionals[0] === "info") {
  try {
    console.log(JSON.stringify(state!.status()));
  } finally {
    state!.close();
  }
} else {
  const hub = state
    ? await startPairedHub(state)
    : await startHub({
        endpoint: process.env.SCOPE_ENDPOINT!,
        token: process.env.SCOPE_TOKEN ?? "",
        port: process.env.SCOPE_PORT ? Number(process.env.SCOPE_PORT) : undefined,
      });
  console.log(`Scope hub listening on ${hub.url}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void hub.close().then(() => {
        state?.close();
        process.exitCode = 0;
      });
    });
}
