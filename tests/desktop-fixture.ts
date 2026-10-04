import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { testDisplay } from "../tools/test-display.ts";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const exec = promisify(execFile);

export async function desktopFixture(
  options: { disableGpu?: boolean; showWindow?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const showWindow = options.showWindow ?? process.env.SCOPE_TEST_SHOW_WINDOWS === "1";
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
    SCOPE_MEMORY_DIR: join(directory, "memory"),
    // Hidden Linux windows stall CSS animations and prevent dialogs from closing.
    SCOPE_TEST_HIDE_WINDOW: showWindow || process.platform === "linux" ? "0" : "1",
    ...options.env,
  };
  // Electron-based development tools can pass their Node-only mode to children.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SCOPE_ENDPOINT;
  delete env.SCOPE_TOKEN;
  delete env.SCOPE_TOKEN_FILE;
  const args = [
    resolve("apps/desktop"),
    ...((options.disableGpu ?? true) ? ["--disable-gpu"] : []),
  ];
  const launch = async () => {
    // Parallel Linux windows can steal focus and release another test's pointer capture.
    const display = process.platform === "linux" && !showWindow ? await testDisplay() : undefined;
    let application: ElectronApplication;
    try {
      application = await electron.launch({
        executablePath: require("electron") as string,
        args,
        env: Object.fromEntries(
          Object.entries({ ...env, ...(display && { DISPLAY: display.display }) }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      });
    } catch (error) {
      await display?.close(false);
      throw error;
    }
    const diagnostics: string[] = [];
    const child = application.process();
    child.stderr?.on("data", (data: Buffer) => {
      diagnostics.push(data.toString());
      if (diagnostics.length > 100) diagnostics.shift();
    });
    const close = application.close.bind(application);
    application.close = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let succeeded = false;
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
        succeeded = true;
      } catch (error) {
        child.kill("SIGKILL");
        throw new Error(
          `${error instanceof Error ? error.message : "Electron close failed."}\n${diagnostics.join("").slice(-8000)}`,
        );
      } finally {
        clearTimeout(timer);
        await display?.close(succeeded);
      }
    };
    try {
      if (!showWindow) {
        await application.evaluate(({ dialog }) => {
          dialog.showMessageBox = async (windowOrOptions, options?: Electron.MessageBoxOptions) => {
            const message = options ?? (windowOrOptions as Electron.MessageBoxOptions);
            console.error(`Unexpected test dialog: ${message.message}`);
            return { response: 1, checkboxChecked: false };
          };
        });
      }
      await application.firstWindow();
      if (process.platform === "linux" || showWindow) {
        await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          if (window.isVisible()) return;
          return new Promise<void>((resolve, reject) => {
            const shown = () => {
              clearTimeout(timer);
              window.removeListener("show", shown);
              resolve();
            };
            const timer = setTimeout(() => {
              window.removeListener("show", shown);
              reject(new Error("Electron did not show its test window within 5 seconds."));
            }, 5_000);
            window.once("show", shown);
          });
        });
      }
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
