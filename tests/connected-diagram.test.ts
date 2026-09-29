import { expect, test } from "vite-plus/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { DiagramAgentReply } from "@irudd-scope/protocol/diagram-agent";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { pressureHub } from "./pressure-fixture.ts";
import { desktopFixture } from "./desktop-fixture.ts";

test.each([false, true])(
  "a publishing agent waits, replies safely, and disconnects without replay (paired=%s)",
  async (paired) => {
    const f = await desktopFixture();
    const hub = paired ? await pressureHub(f.directory) : undefined;
    const cli = hub?.cli ?? f.cli;
    const app = await f.launch();
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Search and controls" }).waitFor();
      if (hub) {
        await page.evaluate((url) => window.scope.pairRemote(url), hub.pairingUrl);
        await expect
          .poll(() => page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
          .toBe("connected");
      }
      const operations = JSON.parse(
        await readFile(new URL("./fixtures/diagram-response.json", import.meta.url), "utf8"),
      ).operations;
      const file = join(f.directory, "operations.json");
      await writeFile(file, JSON.stringify(operations));
      await cli("diagram", "create", file, "--id", "connected", "--title", "Connected diagram");
      await page.getByTestId("main-menu-trigger").click();
      await page.getByRole("button", { name: "Ask agent", exact: true }).click();
      await page
        .getByRole("combobox", { name: "Conversation recipient", exact: true })
        .selectOption("connected");
      await page.getByText("No agent connected", { exact: true }).waitFor();
      expect(
        await page.evaluate(async () => (await window.scope.settings()).diagramGenerationEnabled),
      ).toBe(false);
      const client = hub?.client ?? (await f.connect());
      const wait = () =>
        cli("diagram-agent", "wait", "connected", "--agent", "Original publishing agent").then(
          ({ stdout }) => JSON.parse(stdout) as Extract<DiagramAgentReply, { type: "request" }>,
        );
      const incoming = wait();
      await page
        .getByText("Original publishing agent · Waiting for a request", { exact: true })
        .waitFor();
      await expect(
        client.diagramAgent({ action: "wait", id: "connected", name: "Second agent" }),
      ).rejects.toThrow("already connected");
      await page
        .getByLabel("Change diagram", { exact: true })
        .fill("Rename the browser to Web client.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const request = await incoming;
      expect(request).toMatchObject({
        type: "request",
        id: "connected",
        intent: "Rename the browser to Web client.",
        diagram: { revision: 1 },
      });
      const reply = {
        action: "reply" as const,
        id: "connected",
        requestId: request.requestId,
        token: request.token,
        snapshot: request.diagram.snapshot,
        message: "Renamed the browser.",
        operations: [{ type: "setLabel" as const, id: "browser", label: "Web client" }],
      };
      await expect(client.diagramAgent({ ...reply, id: "another-diagram" })).rejects.toThrow(
        "expired",
      );
      await expect(client.diagramAgent({ ...reply, token: "0".repeat(64) })).rejects.toThrow(
        "credential is invalid",
      );
      const edit = await client.diagram({
        action: "apply",
        id: "connected",
        snapshot: request.diagram.snapshot,
        operations: [{ type: "move", id: "api", x: 600, y: 100 }],
      });
      if (edit.type !== "snapshot") throw new Error("Expected a snapshot.");
      await expect(client.diagramAgent(reply)).rejects.toThrow("canvas changed");
      const replyFile = join(f.directory, "reply.json");
      const body = { ...reply, snapshot: edit.diagram.snapshot };
      await writeFile(replyFile, JSON.stringify(body), { mode: 0o600 });
      expect(JSON.parse((await cli("diagram-agent", "reply", replyFile)).stdout).type).toBe(
        "applied",
      );
      await page.getByText("Renamed the browser.", { exact: true }).waitFor();
      await page.getByText("No agent connected", { exact: true }).waitFor();
      await expect(client.diagramAgent(reply)).rejects.toThrow("expired");
      await expect.poll(async () => (await client.get("connected")).revision).toBe(3);
      const saved = JSON.parse(new TextDecoder().decode(await client.content("connected")));
      expect(
        saved.elements.find((element: { id: string }) => element.id === "agent:browser:label")
          .originalText,
      ).toBe("Web client");
      expect(saved.elements.find((element: { id: string }) => element.id === "agent:api").x).toBe(
        600,
      );

      const canceled = wait();
      await page
        .getByText("Original publishing agent · Waiting for a request", { exact: true })
        .waitFor();
      await page.getByLabel("Change diagram", { exact: true }).fill("A request I will cancel.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const canceledRequest = await canceled;
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByText("No agent connected", { exact: true }).waitFor();
      await expect(
        client.diagramAgent({
          ...reply,
          requestId: canceledRequest.requestId,
          token: canceledRequest.token,
          snapshot: canceledRequest.diagram.snapshot,
        }),
      ).rejects.toThrow("expired");
      const connection = decodeLocalConnection(
        JSON.parse(
          await readFile(hub ? join(f.directory, "hub-connection.json") : f.connectionFile, "utf8"),
        ),
      );
      const controller = new AbortController();
      const disconnected = new ScopeClient(connection.endpoint, connection.token, {
        signal: controller.signal,
      }).diagramAgent({ action: "wait", id: "connected", name: "Disconnecting agent" });
      const rejected = expect(disconnected).rejects.toThrow();
      await page
        .getByText("Disconnecting agent · Waiting for a request", { exact: true })
        .waitFor();
      controller.abort();
      await rejected;
      await page.getByText("No agent connected", { exact: true }).waitFor();
      const reloading = client.diagramAgent({
        action: "wait",
        id: "connected",
        name: "Reloading agent",
      });
      const reloadRejected = expect(reloading).rejects.toThrow();
      await page.getByText("Reloading agent · Waiting for a request", { exact: true }).waitFor();
      await page.reload();
      await reloadRejected;
      await expect
        .poll(() => page.getByRole("combobox", { name: "Conversation recipient" }).inputValue())
        .toBe("embedded");
      await page
        .getByRole("combobox", { name: "Conversation recipient", exact: true })
        .selectOption("connected");
      await page.getByText("No agent connected", { exact: true }).waitFor();
      const closed = client.diagramAgent({
        action: "wait",
        id: "connected",
        name: "Closing agent",
      });
      const closedRejection = expect(closed).rejects.toThrow();
      await page.getByText("Closing agent · Waiting for a request", { exact: true }).waitFor();
      await client.delete("connected");
      await closedRejection;
      expect((await client.list()).length).toBe(0);
    } finally {
      await app.close();
      await hub?.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  60_000,
);
