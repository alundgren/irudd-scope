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

export async function desktopFixture(options: { disableGpu?: boolean; showWindow?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scope-desktop-"));
  const settingsDirectory = join(directory, "desktop");
  const connectionFile = join(directory, "connection.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCOPE_CONNECTION_FILE: connectionFile,
    SCOPE_DESKTOP_DATA_DIR: settingsDirectory,
    SCOPE_DATA_DIR: join(settingsDirectory, "artifacts"),
    SCOPE_PORT: "0",
    SCOPE_SESSION_CREDENTIALS: "1",
    SCOPE_TEST_HIDE_WINDOW:
      (options.showWindow ?? process.env.SCOPE_TEST_SHOW_WINDOWS === "1") ? "0" : "1",
  };
  // Electron-based development tools can pass their Node-only mode to children.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SCOPE_ENDPOINT;
  delete env.SCOPE_TOKEN;
  delete env.SCOPE_TOKEN_FILE;
  const launch = async () => {
    const application = await electron.launch({
      executablePath: require("electron") as string,
      args: [resolve("apps/desktop"), ...((options.disableGpu ?? true) ? ["--disable-gpu"] : [])],
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    const diagnostics: string[] = [];
    const child = application.process();
    child.stderr?.on("data", (data: Buffer) => {
      diagnostics.push(data.toString());
      if (diagnostics.length > 100) diagnostics.shift();
    });
    if (env.SCOPE_TEST_HIDE_WINDOW === "1") {
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (windowOrOptions, options?: Electron.MessageBoxOptions) => {
          const message = options ?? (windowOrOptions as Electron.MessageBoxOptions);
          console.error(`Unexpected test dialog: ${message.message}`);
          return { response: 1, checkboxChecked: false };
        };
      });
    }
    const close = application.close.bind(application);
    application.close = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Electron did not close within 15 seconds.")),
              15_000,
            );
          }),
        ]);
        if (diagnostics.some((line) => line.includes("Unexpected test dialog:")))
          throw new Error("Electron reported a dialog during the test.");
      } catch (error) {
        child.kill("SIGKILL");
        throw new Error(
          `${error instanceof Error ? error.message : "Electron close failed."}\n${diagnostics.join("").slice(-8000)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await application.firstWindow();
      return application;
    } catch (error) {
      await application.close().catch(() => {});
      throw error;
    }
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
      timeout: 15_000,
    });
  return { directory, settingsDirectory, connectionFile, launch, connect, cli };
}
