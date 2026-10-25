import { expect } from "vite-plus/test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { guestNetworkFixture } from "./guest-network-fixture.ts";

export async function guestShutdownChecks() {
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-shutdown-"));
  const network = await guestNetworkFixture(directory);
  const events = join(directory, "events.jsonl");
  const routes = join(directory, "routes.json");
  await writeFile(events, "");
  await writeFile(routes, "{}");
  const fixture = await desktopFixture({
    entry: network.entry,
    env: {
      ...network.env,
      SCOPE_GUEST_TEST_ADDRESS: "100.64.0.1",
      SCOPE_GUEST_FIXTURE_EVENTS: events,
      SCOPE_GUEST_FIXTURE_ROUTES: routes,
    },
  });
  let application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("tab", { name: "Prompts", exact: true }).waitFor();
    await writeFile(network.state, JSON.stringify({ "100.64.0.1": { interruptStart: true } }));
    const interrupted = page.evaluate(() =>
      window.scope.createGuestInvitation("Shutdown test").then(
        () => "opened",
        () => "interrupted",
      ),
    );
    let result: string | undefined;
    void interrupted.then((value) => {
      result = value;
    });
    await expect.poll(() => result, { timeout: 5000 }).toBe("interrupted");
    await writeFile(network.state, "{}");
    const invitation = await page.evaluate(() => window.scope.createGuestInvitation("Retry"));
    expect(invitation.state).toBe("waiting");
    const child = application.process();
    const exited = once(child, "exit");
    await application.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    await expect(exited).resolves.toEqual([0, null]);
    await application.close();

    await writeFile(network.state, JSON.stringify({ "100.64.0.1": { stallStart: true } }));
    await writeFile(events, "");
    application = await fixture.launch();
    const reopened = await application.firstWindow();
    await reopened.getByRole("tab", { name: "Prompts", exact: true }).waitFor();
    await reopened.evaluate(() => {
      void window.scope.createGuestInvitation("Pending startup").catch(() => {});
    });
    await expect
      .poll(async () => (await readFile(events, "utf8")).includes('"kind":"listen"'))
      .toBe(true);
    const pendingChild = application.process();
    const pendingExit = once(pendingChild, "exit");
    await application.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await expect.poll(() => pendingChild.exitCode, { timeout: 5000 }).toBe(0);
    await expect(pendingExit).resolves.toEqual([0, null]);
    await application.close();
    await writeFile(network.state, "{}");
    application = await fixture.launch();
    await (
      await application.firstWindow()
    )
      .getByRole("tab", { name: "Prompts", exact: true })
      .waitFor();
  } finally {
    await application.close();
    await Promise.all(
      [directory, fixture.directory].map((path) => rm(path, { recursive: true, force: true })),
    );
  }
}
