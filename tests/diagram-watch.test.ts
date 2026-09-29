import { expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";

test("diagram watch reports listening after the event stream and initial version check are ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-watch-ready-"));
  const token = "synthetic-watch-readiness-token";
  const status = Promise.withResolvers<void>();
  let checking = false;
  const server = await startArtifactServer({
    directory,
    token,
    port: 0,
    syncDiagram: async (command) => {
      checking = true;
      await status.promise;
      return { type: "status", name: command.name, version: "a".repeat(64), revision: 1 };
    },
  });
  let listener: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const client = new ScopeClient(server.url, token);
    await client.publish(
      "watch-ready",
      {
        name: "watch-ready",
        title: "Watch readiness",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "drawing.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(nativeDiagram(1))),
    );
    listener = spawn(
      process.execPath,
      [resolve("packages/cli/dist/main.mjs"), "diagram", "watch", "watch-ready"],
      {
        cwd: directory,
        env: {
          ...process.env,
          SCOPE_ENDPOINT: server.url,
          SCOPE_TOKEN: token,
          SCOPE_TOKEN_FILE: undefined,
          SCOPE_CONNECTION_FILE: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = once(listener, "exit");
    let diagnostics = "";
    listener.stderr!.on("data", (data) => {
      diagnostics += data;
    });
    await expect.poll(() => checking, { timeout: 5000 }).toBe(true);
    expect(diagnostics).not.toContain("Listening");
    status.resolve();
    await expect.poll(() => diagnostics, { timeout: 5000 }).toContain("Listening to watch-ready.");
    await client.delete("watch-ready");
    await expect.poll(() => listener!.exitCode, { timeout: 5000 }).toBe(0);
  } finally {
    status.resolve();
    listener?.kill();
    await closed;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function rejectingAppServer(rejectMethod: string) {
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        const offset = length === 126 ? 4 : 2;
        if (offset === 4) length = pending.readUInt16BE(2);
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4);
        const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
        pending = pending.subarray(offset + 4 + length);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        const message = JSON.parse(payload.toString());
        if (message.id === undefined) continue;
        const body = Buffer.from(
          JSON.stringify({
            id: message.id,
            ...(message.method === rejectMethod
              ? { error: { code: -32602, message: "Synthetic host rejection" } }
              : { result: {} }),
          }),
        );
        socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
      }
    });
  });
  return server;
}

test.for(["initialize", "thread/read"])(
  "a rejected Codex %s closes its connection and exits",
  async (method) => {
    const fixture = await desktopFixture();
    const application = await fixture.launch();
    const server = rejectingAppServer(method);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    let listener: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      const page = await application.firstWindow();
      await page.getByRole("button", { name: "Search and controls" }).waitFor();
      const file = join(fixture.directory, "drawing.excalidraw");
      await writeFile(file, JSON.stringify(nativeDiagram(1)));
      const artifact = JSON.parse((await fixture.cli("add", file, "--named")).stdout);
      listener = spawn(
        process.execPath,
        [
          resolve("packages/cli/dist/main.mjs"),
          "diagram",
          "watch",
          artifact.name,
          "--codex-thread",
          "missing-thread",
          "--codex-url",
          `ws://127.0.0.1:${address.port}`,
        ],
        {
          cwd: fixture.directory,
          env: {
            ...process.env,
            SCOPE_CONNECTION_FILE: fixture.connectionFile,
            SCOPE_ENDPOINT: undefined,
            SCOPE_TOKEN: undefined,
            SCOPE_TOKEN_FILE: undefined,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      closed = once(listener, "exit");
      let diagnostics = "";
      listener.stderr!.on("data", (data) => {
        diagnostics += data;
      });
      await expect.poll(() => listener!.exitCode, { timeout: 5000 }).toBe(1);
      expect(diagnostics).toContain("Synthetic host rejection");
    } finally {
      listener?.kill();
      await closed;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await application.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  },
);

test("human edits push to T3 with idempotent retry; connected replies do not echo, and deletion stops the listener", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  const requests: { commandId: string; threadId: string; message: { text: string } }[] = [];
  const host = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer synthetic-t3-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          thread: { id: "test-thread", runtimeMode: "full-access", interactionMode: "default" },
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(requests.length === 1 ? 500 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ sequence: requests.length }));
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("Missing host address");
  let listener: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    const file = join(fixture.directory, "drawing.excalidraw");
    await writeFile(file, JSON.stringify(nativeDiagram(1)));
    const tokenFile = join(fixture.directory, "host-token");
    await writeFile(tokenFile, "synthetic-t3-token", { mode: 0o600 });
    const artifact = JSON.parse(
      (await fixture.cli("add", file, "--named", "--title", "Push diagram")).stdout,
    );
    const client = await fixture.connect();
    const initial = await client.syncDiagram({ action: "read", name: artifact.name });
    if (initial.type !== "full") throw new Error("Expected full diagram");
    listener = spawn(
      process.execPath,
      [
        resolve("packages/cli/dist/main.mjs"),
        "diagram",
        "watch",
        artifact.name,
        "--t3-thread",
        "test-thread",
        "--watch-edits",
        "--t3-endpoint",
        `http://127.0.0.1:${address.port}`,
        "--t3-token-file",
        tokenFile,
      ],
      {
        cwd: fixture.directory,
        env: {
          ...process.env,
          SCOPE_CONNECTION_FILE: fixture.connectionFile,
          SCOPE_ENDPOINT: undefined,
          SCOPE_TOKEN: undefined,
          SCOPE_TOKEN_FILE: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = once(listener, "exit");
    let diagnostics = "";
    listener.stderr!.on("data", (data) => {
      diagnostics += data;
    });
    await expect.poll(() => diagnostics).toContain("Listening");
    await client.syncDiagram({
      action: "write",
      name: artifact.name,
      expectedVersion: initial.version,
      delta: { elements: [{ id: "object-0", set: { x: 100 } }], deleted: [], files: {} },
    });
    await delay(1000);
    expect(requests).toHaveLength(0);
    await page.locator(".excalidraw canvas.interactive").click({ position: { x: 500, y: 200 } });
    await page.keyboard.press("t");
    await page.mouse.click(400, 350);
    await page.locator("textarea.excalidraw-wysiwyg").fill("Human canvas edit");
    await page.keyboard.press("Escape");
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(2);
    expect(requests[0].commandId).toBe(requests[1].commandId);
    expect(requests[1]).toMatchObject({
      threadId: "test-thread",
      message: { text: expect.stringContaining('"event":"changed"') },
    });
    await page.getByTestId("main-menu-trigger").click();
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page.getByRole("textbox", { name: "Change diagram" }).fill("Move the new label left.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);
    expect(requests[2].message.text).toContain("Move the new label left.");
    await fixture.cli("diagram", "reply", artifact.name, "Received your diagram change.");
    await page.getByText("Received your diagram change.", { exact: true }).waitFor();
    const recipient = page.getByRole("combobox", { name: "Conversation recipient" });
    expect(await recipient.count()).toBe(1);
    await recipient.selectOption("connected");
    const waiting = client.diagramAgent({ action: "wait", id: artifact.id, name: "Waiting agent" });
    await page.getByText("Waiting agent · Waiting for a request", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Change diagram" }).fill("Rename the first object.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const request = await waiting;
    if (request.type !== "request") throw new Error("Expected a connected-agent request");
    expect(request.intent).toBe("Rename the first object.");
    await client.diagramAgent({
      action: "reply",
      id: artifact.id,
      requestId: request.requestId,
      token: request.token,
      snapshot: request.diagram.snapshot,
      message: "Renamed through the waiting connection.",
      operations: [{ type: "setLabel", id: request.diagram.scene.nodes[0].id, label: "Renamed" }],
    });
    await page.getByText("Renamed through the waiting connection.", { exact: true }).waitFor();
    const updated = await client.syncDiagram({ action: "read", name: artifact.name });
    if (updated.type !== "full") throw new Error("Expected the updated native diagram");
    expect(updated.document.elements.some((element) => element.originalText === "Renamed")).toBe(
      true,
    );
    await delay(1000);
    expect(requests).toHaveLength(3);
    await recipient.selectOption("external");
    await page.getByRole("textbox", { name: "Change diagram" }).fill("Back to the host listener.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(4);
    expect(requests[3].message.text).toContain("Back to the host listener.");
    await client.delete(artifact.id);
    await expect.poll(() => listener!.exitCode).toBe(0);
  } finally {
    listener?.kill();
    await closed;
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);

test("Claude channel performs MCP handshake and sends human messages without diagram payloads", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  let listener: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    const file = join(fixture.directory, "drawing.excalidraw");
    await writeFile(file, JSON.stringify(nativeDiagram(1)));
    const artifact = JSON.parse((await fixture.cli("add", file, "--named")).stdout);
    await (await fixture.connect()).syncDiagram({ action: "status", name: artifact.name });
    listener = spawn(
      process.execPath,
      [
        resolve("packages/cli/dist/main.mjs"),
        "diagram",
        "watch",
        artifact.name,
        "--claude-channel",
      ],
      {
        cwd: fixture.directory,
        env: {
          ...process.env,
          SCOPE_CONNECTION_FILE: fixture.connectionFile,
          SCOPE_ENDPOINT: undefined,
          SCOPE_TOKEN: undefined,
          SCOPE_TOKEN_FILE: undefined,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    closed = once(listener, "exit");
    let output = "",
      diagnostics = "";
    listener.stdout!.on("data", (data) => {
      output += data;
    });
    listener.stderr!.on("data", (data) => {
      diagnostics += data;
    });
    listener.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`,
    );
    await expect.poll(() => output).toContain('"claude/channel"');
    listener.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    await expect.poll(() => diagnostics).toContain("Listening");
    await page.getByTestId("main-menu-trigger").click();
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page.getByRole("textbox", { name: "Change diagram" }).fill("Claude test message");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => output).toContain("notifications/claude/channel");
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const notification = messages.find((item) => item.method === "notifications/claude/channel");
    expect(notification.params.content).toContain("Claude test message");
    expect(notification.params.content).not.toContain('"elements"');
    expect(messages[0].result.protocolVersion).toBe("2025-11-25");
    listener.stdin!.end();
    await expect.poll(() => listener!.exitCode).toBe(0);
    expect((await readFile(file, "utf8")).length).toBeGreaterThan(0);
  } finally {
    listener?.kill();
    await closed;
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);
