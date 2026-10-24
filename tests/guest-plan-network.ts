import { expect } from "vite-plus/test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readPairingUrl } from "@irudd-scope/protocol/remote";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { cliMain, spawnedHub } from "./hub-fixture.ts";

/** Real hub admission with an older desktop, and built CLI discovery against an older hub. */
export async function guestPlanNetwork(directory: string) {
  const hub = await spawnedHub(join(directory, "old-desktop"));
  const relay = new AbortController();
  const old = createServer((_request, response) =>
    response
      .writeHead(404, { "Content-Type": "application/json" })
      .end('{"error":"Endpoint not found."}'),
  );
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  try {
    const pairing = readPairingUrl(hub.pairUrl);
    const receipt = await fetch(`${hub.endpoint}/v1/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Older desktop" }),
    }).then((r) => r.json());
    const events = await fetch(`${hub.endpoint}/v1/relay/events`, {
      headers: { Authorization: `Bearer ${receipt.token}` },
      signal: relay.signal,
    });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const chunk of events.body!.pipeThrough(new TextDecoderStream()))
        lines.push(chunk);
    })().catch(() => {});
    const client = new ScopeClient(hub.endpoint, hub.token);
    await expect(client.guestCapabilities()).rejects.toThrow(/Update Scope/);
    for (const route of [
      "source",
      "read",
      "pending",
      "prepare",
      "execute",
      "status",
      "reconcile",
    ]) {
      const response = await fetch(`${hub.endpoint}/v1/guests/${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(501);
    }
    expect(lines.join("")).not.toContain('"request"');
    const credentials: Record<string, string>[] = [
      {},
      { Authorization: `Bearer ${receipt.token}` },
      { Authorization: `Bearer ${hub.token}`, Origin: "https://example.invalid" },
    ];
    for (const headers of credentials) {
      expect((await fetch(`${hub.endpoint}/v1/guests/capabilities`, { headers })).status).toBe(
        headers.Origin ? 403 : 401,
      );
    }
    relay.abort();
    await reading;
    await expect(
      client.guestSource({
        ownerDeviceId: "11111111-1111-4111-8111-111111111111",
        sourceTabId: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ status: 503 });
    const result = await fetch(`${hub.endpoint}/v1/hub/queue`, {
      headers: { Authorization: `Bearer ${hub.token}` },
    }).then((r) => r.json());
    expect(result.entries).toEqual([]);
    const endpoint = `http://127.0.0.1:${(old.address() as { port: number }).port}`;
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          cliMain,
          "plan",
          "read",
          "same-id",
          "--owner-device",
          "11111111-1111-4111-8111-111111111111",
          "--source-tab",
          "22222222-2222-4222-8222-222222222222",
        ],
        {
          env: {
            ...process.env,
            SCOPE_ENDPOINT: endpoint,
            SCOPE_TOKEN: "synthetic-old-hub-publishing-token",
            SCOPE_TOKEN_FILE: undefined,
          },
          timeout: 15000,
        },
      ),
    ).rejects.toThrow(/Update Scope and the paired hub/);
  } finally {
    relay.abort();
    old.closeAllConnections();
    await new Promise<void>((resolve) => old.close(() => resolve()));
    await hub.stop();
  }
}
