import { expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces, tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { ScopeError, type DiagramEvent } from "@irudd-scope/protocol";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";

async function deliveryFixture(host = "127.0.0.1", busyChecks = 0, busyStatus = 409) {
  const directory = await mkdtemp(join(tmpdir(), "scope-watch-delivery-"));
  const token = "synthetic-scope-delivery-token";
  let revision = 1;
  const version = () => revision.toString(16).padStart(64, "0");
  const startScope = (port = 0, publishingToken = token) =>
    startArtifactServer({
      directory,
      token: publishingToken,
      port,
      syncDiagram: async (command) => {
        if (busyChecks-- > 0) throw new ScopeError(busyStatus, "The diagram is busy. Retry later.");
        return { type: "status", name: command.name, version: version(), revision };
      },
    });
  let scope = await startScope();
  const requests: { message: { text: string } }[] = [];
  let reads = 0;
  let readStatus = 200;
  let deliveryStatus = 200;
  const t3 = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer synthetic-t3-token") {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET") {
      reads++;
      if (readStatus !== 200) {
        response.writeHead(readStatus).end(JSON.stringify({ error: "Synthetic T3 outage" }));
        return;
      }
      response.end(
        JSON.stringify({
          thread: { id: "test-thread", runtimeMode: "full-access", interactionMode: "default" },
        }),
      );
    } else {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(deliveryStatus);
      response.end(JSON.stringify({ sequence: requests.length }));
    }
  });
  t3.listen(0, host);
  await once(t3, "listening");
  const address = t3.address();
  if (!address || typeof address === "string") throw new Error("Missing T3 address");
  const endpoint = `http://${host}:${address.port}`;
  const tokenFile = join(directory, "t3-token");
  await writeFile(tokenFile, "synthetic-t3-token", { mode: 0o600 });
  const client = new ScopeClient(scope.url, token);
  await client.publish(
    "watch-delivery",
    {
      name: "watch-delivery",
      title: "Watch delivery",
      kind: "excalidraw",
      mediaType: "application/vnd.excalidraw+json",
      fileName: "drawing.excalidraw",
      expectedRevision: 0,
    },
    Buffer.from(JSON.stringify(nativeDiagram(1))),
  );
  const listeners: { process: ReturnType<typeof spawn>; closed: Promise<unknown> }[] = [];
  return {
    endpoint,
    tokenFile,
    scopeEndpoint: () => scope.url,
    requests,
    reads: () => reads,
    setReadStatus(status: number) {
      readStatus = status;
    },
    setDeliveryStatus(status: number) {
      deliveryStatus = status;
    },
    async disconnectScope() {
      await scope.close();
    },
    async disconnectT3() {
      t3.closeAllConnections();
      await new Promise<void>((resolve) => t3.close(() => resolve()));
    },
    async reconnectT3() {
      t3.listen(address.port, host);
      await once(t3, "listening");
    },
    async restart(publishingToken = token) {
      await scope.close();
      revision++;
      scope = await startScope(Number(new URL(scope.url).port), publishingToken);
    },
    emit(event: DiagramEvent["event"], text?: string) {
      revision++;
      scope.store.onChanged?.({
        type: "diagram",
        id: "watch-delivery",
        name: "watch-delivery",
        event,
        version: version(),
        ...(text ? { text } : {}),
      });
      return version();
    },
    start(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
      const child = spawn(
        process.execPath,
        [resolve("packages/cli/dist/main.mjs"), "diagram", "watch", "watch-delivery", ...args],
        {
          cwd: directory,
          env: {
            ...process.env,
            SCOPE_ENDPOINT: scope.url,
            SCOPE_TOKEN: token,
            SCOPE_TOKEN_FILE: undefined,
            SCOPE_CONNECTION_FILE: undefined,
            SCOPE_T3_TOKEN_FILE: tokenFile,
            T3CODE_HOST: host,
            T3CODE_PORT: String(address.port),
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const closed = once(child, "exit");
      listeners.push({ process: child, closed });
      let diagnostics = "",
        output = "";
      child.stderr!.on("data", (data) => (diagnostics += data));
      child.stdout!.on("data", (data) => (output += data));
      return { process: child, closed, diagnostics: () => diagnostics, output: () => output };
    },
    async close() {
      for (const listener of listeners) listener.process.kill();
      await Promise.all(listeners.map((listener) => listener.closed));
      t3.closeAllConnections();
      await new Promise<void>((resolve) => t3.close(() => resolve()));
      await scope.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("T3 wakes for messages and proposal decisions; edits and new proposals wait for a request", async () => {
  const fixture = await deliveryFixture();
  try {
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    for (let i = 0; i < 16; i++) fixture.emit("changed");
    fixture.emit("proposal");
    await delay(1100);
    expect(fixture.requests).toHaveLength(0);
    const requestedVersion = fixture.emit("message", "Move the label left.");
    const edits = setInterval(() => fixture.emit("changed"), 100);
    try {
      await expect.poll(() => fixture.requests.length, { timeout: 3000 }).toBe(1);
    } finally {
      clearInterval(edits);
    }
    expect(fixture.requests[0].message.text).toContain("Move the label left.");
    expect(fixture.requests[0].message.text).toContain(requestedVersion);
    expect(fixture.requests[0].message.text).not.toContain('"event":"changed"');
    fixture.emit("accepted");
    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.requests[1].message.text).toContain('"event":"accepted"');
    fixture.emit("rejected");
    await expect.poll(() => fixture.requests.length).toBe(3);
    expect(fixture.requests[2].message.text).toContain('"event":"rejected"');
  } finally {
    await fixture.close();
  }
});

test("stdout observers keep edit and proposal notices", async () => {
  const fixture = await deliveryFixture();
  try {
    const listener = fixture.start();
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    fixture.emit("changed");
    fixture.emit("proposal");
    await expect.poll(listener.output).toContain('\\"event\\":\\"changed\\"');
    expect(listener.output()).toContain('\\"event\\":\\"proposal\\"');
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test.for([409, 503])(
  "an editor returning %s does not terminate the listener before it becomes available",
  async (status) => {
    const fixture = await deliveryFixture("127.0.0.1", 6, status);
    try {
      const listener = fixture.start(["--t3-thread", "test-thread"]);
      await expect.poll(listener.diagnostics, { timeout: 10_000 }).toContain("Listening");
      expect(listener.process.exitCode).toBeNull();
      fixture.emit("message", "Now move the label.");
      await expect.poll(() => fixture.requests.length).toBe(1);
    } finally {
      await fixture.close();
    }
  },
);

test("a waiting listener can be stopped while the editor remains unavailable", async () => {
  const fixture = await deliveryFixture("127.0.0.1", 100);
  try {
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect
      .poll(listener.diagnostics, { timeout: 5_000 })
      .toContain("Waiting for the diagram editor");
    listener.process.kill();
    await expect.poll(() => listener.process.exitCode).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("the listener reconnects after Scope restarts without waking T3 for missed canvas edits", async () => {
  const fixture = await deliveryFixture();
  try {
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    await fixture.restart();
    await expect
      .poll(() => listener.diagnostics().match(/Listening/g)?.length, { timeout: 5000 })
      .toBe(2);
    await delay(1000);
    expect(fixture.requests).toHaveLength(0);
    fixture.emit("message", "Continue after reconnecting.");
    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.requests[0].message.text).toContain("Continue after reconnecting.");
  } finally {
    await fixture.close();
  }
});

test.for(["Scope", "T3"])("the listener survives a %s startup outage", async (service) => {
  const fixture = await deliveryFixture();
  try {
    if (service === "Scope") await fixture.disconnectScope();
    else await fixture.disconnectT3();
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain(`Waiting for ${service}`);
    expect(listener.process.exitCode).toBeNull();
    if (service === "Scope") await fixture.restart();
    else await fixture.reconnectT3();
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    fixture.emit("message", "Please finish the edit.");
    await expect.poll(() => fixture.requests.length).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("Scope authentication failure on reconnect stops the listener", async () => {
  const fixture = await deliveryFixture();
  try {
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    await fixture.restart("replacement-synthetic-scope-token");
    await expect.poll(() => listener.process.exitCode, { timeout: 5000 }).toBe(1);
    expect(listener.diagnostics()).toContain("A valid publishing token is required");
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test("T3 startup retries service unavailability, but an uncertain dispatch terminates the listener", async () => {
  const fixture = await deliveryFixture();
  try {
    fixture.setReadStatus(503);
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Waiting for T3");
    fixture.setReadStatus(200);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    fixture.setDeliveryStatus(503);
    fixture.emit("message", "One request, with a bounded delivery retry.");
    await listener.closed;
    expect(listener.process.exitCode).toBe(1);
    expect(fixture.requests).toHaveLength(2);
    expect(listener.diagnostics()).toContain("T3 returned 503");
  } finally {
    await fixture.close();
  }
});

test.for(["Scope credentials", "T3 credentials", "T3 contract", "missing diagram"])(
  "%s failure is terminal during startup",
  async (failure) => {
    const fixture = await deliveryFixture();
    try {
      if (failure === "T3 credentials")
        await writeFile(fixture.tokenFile, "invalid-synthetic-t3-token");
      if (failure === "missing diagram")
        await new ScopeClient(fixture.scopeEndpoint(), "synthetic-scope-delivery-token").delete(
          "watch-delivery",
        );
      const listener = fixture.start(
        ["--t3-thread", failure === "T3 contract" ? "different-thread" : "test-thread"],
        failure === "Scope credentials" ? { SCOPE_TOKEN: "invalid-synthetic-scope-token" } : {},
      );
      await expect.poll(() => listener.process.exitCode, { timeout: 5_000 }).toBe(1);
      expect(listener.diagnostics()).not.toContain("Waiting for");
      expect(listener.diagnostics()).not.toContain("Listening");
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  },
);

test("a reconnect checks again after a delayed status response from the previous stream", async () => {
  const fixture = await deliveryFixture();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const streams: import("node:http").ServerResponse[] = [];
  let checks = 0;
  const proxy = createServer(async (request, response) => {
    if (request.url === "/v1/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"type":"ready"}\n\n');
      streams.push(response);
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = await fetch(`${fixture.scopeEndpoint()}${request.url}`, {
      method: request.method,
      headers: {
        Authorization: request.headers.authorization!,
        "Content-Type": "application/json",
      },
      ...(body ? { body } : {}),
    });
    const output = await result.text();
    if (request.url === "/v1/diagrams/sync" && ++checks === 1) {
      held.resolve();
      await release.promise;
    }
    response.writeHead(result.status, { "Content-Type": "application/json" }).end(output);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  try {
    const listener = fixture.start(["--t3-thread", "test-thread", "--watch-edits"], {
      SCOPE_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    await held.promise;
    const current = fixture.emit("changed");
    streams[0].end();
    await expect.poll(() => streams.length, { timeout: 5000 }).toBe(2);
    release.resolve();
    await expect.poll(() => fixture.requests.length, { timeout: 5000 }).toBe(1);
    expect(fixture.requests[0].message.text).toContain(current);
    expect(listener.process.exitCode).toBeNull();
  } finally {
    release.resolve();
    await fixture.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

test("T3 uses its configured address on this machine without a loopback proxy", async (context) => {
  const host = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  if (!host) context.skip(true, "No non-loopback IPv4 interface is available.");
  const fixture = await deliveryFixture(host);
  try {
    const listener = fixture.start(["--t3-thread", "test-thread"]);
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    fixture.emit("message", "Use the direct connection.");
    await expect.poll(() => fixture.requests.length).toBe(1);
    expect(fixture.reads()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("an explicit T3 address overrides environment defaults and connection errors identify it", async () => {
  const fixture = await deliveryFixture();
  try {
    const listener = fixture.start(
      ["--t3-thread", "test-thread", "--t3-endpoint", fixture.endpoint],
      { T3CODE_HOST: "203.0.113.7", T3CODE_PORT: "1" },
    );
    await expect.poll(listener.diagnostics, { timeout: 5_000 }).toContain("Listening");
    const unreachable = fixture.start([
      "--t3-thread",
      "test-thread",
      "--t3-endpoint",
      "http://127.0.0.1:1",
    ]);
    await expect
      .poll(unreachable.diagnostics, { timeout: 5_000 })
      .toContain("Cannot reach T3 at http://127.0.0.1:1");
    expect(unreachable.diagnostics()).not.toContain("synthetic-t3-token");
    unreachable.process.kill();
    await expect.poll(() => unreachable.process.exitCode).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("T3 rejects remote HTTP and endpoint credentials, paths and query parameters", async () => {
  const fixture = await deliveryFixture();
  try {
    for (const endpoint of [
      "http://203.0.113.7:3773",
      fixture.endpoint.replace("http://", "http://private:secret@"),
      `${fixture.endpoint}/untrusted`,
      `${fixture.endpoint}?token=secret`,
      `${fixture.endpoint}#untrusted`,
    ]) {
      const listener = fixture.start(["--t3-thread", "test-thread", "--t3-endpoint", endpoint]);
      await expect.poll(() => listener.process.exitCode, { timeout: 5_000 }).toBe(1);
      expect(listener.diagnostics()).not.toContain("Listening");
      expect(listener.diagnostics()).not.toContain("secret");
    }
    expect(fixture.reads()).toBe(0);
    expect(fixture.requests).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
