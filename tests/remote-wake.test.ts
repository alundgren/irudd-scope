import { expect, test } from "vite-plus/test";
import { rm } from "node:fs/promises";
import { desktopFixture } from "./desktop-fixture.ts";
import { pressureHub } from "./pressure-fixture.ts";

test("the Electron resume event reconnects enabled remotes with a wake signal and keeps disabled remotes off", async () => {
  const desktop = await desktopFixture();
  const hub = await pressureHub(desktop.directory);
  const application = await desktop.launch();
  try {
    await application.evaluate(() => {
      const fetcher = globalThis.fetch;
      const requests: (string | null)[] = [];
      Object.assign(globalThis, { scopeWakeRequests: requests });
      globalThis.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/v1/relay/events"))
          requests.push(new Headers(init?.headers).get("Scope-Relay-Wake"));
        return fetcher(input, init);
      };
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    await page.evaluate((url) => window.scope.pairRemote(url), hub.pairingUrl);
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
      .toBe("connected");
    const requests = () =>
      application.evaluate(
        () =>
          (globalThis as typeof globalThis & { scopeWakeRequests: (string | null)[] })
            .scopeWakeRequests,
      );
    expect(await requests()).toEqual([null]);
    await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    await expect.poll(requests).toContain("1");
    await expect
      .poll(() => page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
      .toBe("connected");
    const receipt = JSON.parse(
      (await hub.cli("text", "After waking", "--id", "wake-report")).stdout,
    );
    expect(receipt).toMatchObject({ id: "wake-report", queued: true });
    await expect.poll(async () => (await hub.client.get("wake-report")).revision).toBe(1);
    expect(Buffer.from(await hub.client.content("wake-report")).toString()).toBe("After waking");
    await page.evaluate(async () => {
      const remote = (await window.scope.remotes())[0];
      await window.scope.setRemoteEnabled(remote.id, false);
    });
    const count = (await requests()).length;
    await application.evaluate(({ powerMonitor }) => powerMonitor.emit("resume"));
    expect(await page.evaluate(async () => (await window.scope.remotes())[0])).toMatchObject({
      enabled: false,
      connection: "disconnected",
    });
    expect((await requests()).length).toBe(count);
  } finally {
    await application.close();
    await hub.close();
    await rm(desktop.directory, { recursive: true, force: true });
  }
});
