import type { ElectronApplication } from "@playwright/test";
import { expect } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function guestShutdownFailure(application: ElectronApplication, directory: string) {
  const page = await application.firstWindow();
  const invitation = await page.evaluate(() =>
    window.scope.createGuestInvitation("Cleanup failure"),
  );
  const database = new DatabaseSync(join(directory, "desktop.db"));
  try {
    database
      .prepare(
        "INSERT INTO preferences(name, document) VALUES ('guest-peers', ?) ON CONFLICT(name) DO UPDATE SET document = excluded.document",
      )
      .run(
        JSON.stringify([
          {
            id: invitation.id,
            deviceId: randomUUID(),
            name: "Incomplete peer",
            createdAt: Date.now(),
          },
        ]),
      );
    database.exec(
      "CREATE TRIGGER reject_shutdown_revocation BEFORE UPDATE ON preferences WHEN NEW.name = 'guest-settings' BEGIN SELECT RAISE(ABORT, 'Synthetic shutdown revocation failure'); END",
    );
  } finally {
    database.close();
  }
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options?: Electron.MessageBoxOptions) => {
      return new Promise((resolve) => {
        (
          globalThis as unknown as {
            shutdownError: { options: Electron.MessageBoxOptions; acknowledge: () => void };
          }
        ).shutdownError = {
          options: options!,
          acknowledge: () => resolve({ response: 0, checkboxChecked: false }),
        };
      });
    };
  });
  const child = application.process();
  const exited = once(child, "exit");
  await application.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect
    .poll(() =>
      application.evaluate(
        () =>
          (globalThis as unknown as { shutdownError?: { options: Electron.MessageBoxOptions } })
            .shutdownError?.options,
      ),
    )
    .toMatchObject({
      type: "error",
      message: "Scope could not finish closing.",
      buttons: ["Quit Scope"],
    });
  expect(child.exitCode).toBe(null);
  await application.evaluate(() => {
    setImmediate(() =>
      (
        globalThis as unknown as { shutdownError: { acknowledge: () => void } }
      ).shutdownError.acknowledge(),
    );
  });
  await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(1);
  await expect(exited).resolves.toEqual([1, null]);
}
