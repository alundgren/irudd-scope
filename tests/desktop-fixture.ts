import { _electron as electron } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const exec = promisify(execFile);

export async function desktopFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-desktop-"));
  const settingsDirectory = join(directory, "desktop");
  const connectionFile = join(directory, "connection.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCOPE_CONNECTION_FILE: connectionFile,
    SCOPE_DESKTOP_DATA_DIR: settingsDirectory,
    SCOPE_DATA_DIR: join(settingsDirectory, "artifacts"),
    SCOPE_PORT: "0",
  };
  // Electron-based development tools can pass their Node-only mode to children.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SCOPE_ENDPOINT;
  delete env.SCOPE_TOKEN;
  delete env.SCOPE_TOKEN_FILE;
  const launch = async () => {
    const application = await electron.launch({
      executablePath: require("electron") as string,
      args: [resolve("apps/desktop"), "--disable-gpu"],
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    await application.firstWindow();
    return application;
  };
  const connect = async () => {
    const { endpoint, token } = decodeLocalConnection(
      JSON.parse(await readFile(connectionFile, "utf8")),
    );
    return new ScopeClient(endpoint, token);
  };
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env,
      maxBuffer: 2 * 1024 * 1024,
    });
  return { directory, settingsDirectory, connectionFile, launch, connect, cli };
}
