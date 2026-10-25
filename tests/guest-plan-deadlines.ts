import { expect } from "vite-plus/test";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { resolve } from "node:path";
import { once } from "node:events";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { GuestTarget } from "@irudd-scope/protocol/guest-operation";

type Connection = { endpoint: string; token: string };
function progressing(
  connection: Connection,
  path: string,
  input: unknown,
  duration: number,
  options: { method?: string; abort?: boolean; headers?: Record<string, string> } = {},
) {
  const started = performance.now();
  let pulse: ReturnType<typeof setInterval>;
  let finish: ReturnType<typeof setTimeout>;
  let outgoing: ReturnType<typeof request>;
  const done = new Promise<{ status: number; elapsed: number; body: string }>((resolve, reject) => {
    const clear = () => {
      clearInterval(pulse);
      clearTimeout(finish);
    };
    outgoing = request(
      connection.endpoint + path,
      {
        method: options.method ?? "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      },
      (incoming) => {
        const parts: Buffer[] = [];
        incoming.on("data", (part) => parts.push(part));
        incoming.on("error", reject);
        incoming.on("end", () => {
          clear();
          resolve({
            status: incoming.statusCode!,
            elapsed: performance.now() - started,
            body: Buffer.concat(parts).toString(),
          });
        });
      },
    );
    outgoing.on("error", (error) => {
      clear();
      if (options.abort) resolve({ status: 0, elapsed: performance.now() - started, body: "" });
      else reject(error);
    });
    outgoing.write(JSON.stringify(input));
    pulse = setInterval(() => outgoing.write(" "), 250);
    finish = setTimeout(() => {
      clearInterval(pulse);
      if (options.abort) outgoing.destroy();
      else outgoing.end();
    }, duration);
  });
  // The caller checks every result after the concurrent slow transfers finish.
  void done.catch(() => {});
  return {
    done,
    close: () => {
      clearInterval(pulse);
      clearTimeout(finish);
      outgoing.destroy();
    },
  };
}

/** Actual elapsed uploads through the built stateless hub, paired relay and desktop HTTP server. */
export async function guestPlanDeadlines(
  direct: Connection,
  paired: Connection,
  target: GuestTarget,
) {
  const forwarding = spawn(process.execPath, [resolve("apps/hub/dist/main.mjs")], {
    env: {
      ...process.env,
      SCOPE_ENDPOINT: direct.endpoint,
      SCOPE_TOKEN: direct.token,
      SCOPE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stopped = once(forwarding, "exit");
  const uploads: ReturnType<typeof progressing>[] = [];
  const client = new ScopeClient(direct.endpoint, direct.token);
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      forwarding.stdout.on("data", (chunk: Buffer) => {
        const found = /Scope hub listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
        if (found) resolve(found[1]);
      });
      forwarding.once("exit", () => reject(new Error("Stateless hub exited before listening.")));
    });
    const connections = [direct, { endpoint, token: direct.token }, paired];
    const source = (await client.guestSource(target))!;
    const change = {
      version: 1,
      target,
      expectedRevision: source.artifact!.revision,
      expectedSourceVersion: source.sourceVersion,
      action: { kind: "capture-basis", basisId: "deadline-only" },
    };
    const upload = (...args: Parameters<typeof progressing>) => {
      const item = progressing(...args);
      uploads.push(item);
      return item.done;
    };
    for (const connection of connections) {
      const rejected = await upload(connection, "/v1/guests/prepare", change, 35000, {
        headers: { Authorization: "Bearer synthetic-invalid-token" },
      });
      expect(rejected.status).toBe(401);
      expect(rejected.elapsed).toBeLessThan(5000);
      expect(
        (await upload(connection, "/v1/guests/prepare?unexpected=1", change, 35000)).status,
      ).toBe(404);
      expect(
        (
          await upload(connection, "/v1/guests/prepare", change, 35000, {
            headers: { Origin: "https://example.invalid" },
          })
        ).status,
      ).toBe(403);
    }
    const bounded = connections.map((connection) =>
      upload(connection, "/v1/guests/prepare", change, 130000),
    );
    const ordinary = connections.map((connection) =>
      upload(connection, "/v1/artifacts/deadline-ordinary", {}, 35000, { method: "PUT" }),
    );
    for (const connection of connections) {
      const result = await upload(connection, "/v1/guests/prepare", change, 35000);
      expect(result.elapsed).toBeGreaterThanOrEqual(35000);
      expect(result.status).toBe(200);
      const operation = JSON.parse(result.body);
      expect((await client.guestPending(target))!.operation.operationId).toBe(
        operation.operationId,
      );
      const identity = { operationId: operation.operationId, digest: operation.digest };
      expect((await client.guestStatus(target, identity)).state).toBe("rejected");
      await client.guestReconcile(target, identity);
    }
    for (const [index, result] of (await Promise.all(ordinary)).entries()) {
      expect(result.status).toBe(index === 2 ? 503 : 408);
      expect(result.elapsed).toBeGreaterThanOrEqual(29000);
      expect(result.elapsed).toBeLessThan(34000);
    }
    for (const [index, result] of (await Promise.all(bounded)).entries()) {
      expect(result.status).toBe(index === 2 ? 503 : 408);
      expect(result.elapsed).toBeGreaterThanOrEqual(119000);
      expect(result.elapsed).toBeLessThan(128000);
    }
    expect(await client.guestPending(target)).toBeNull();
    for (const connection of connections) {
      await upload(connection, "/v1/guests/prepare", change, 1000, { abort: true });
      expect(await client.guestPending(target)).toBeNull();
      expect(
        await new ScopeClient(connection.endpoint, connection.token).guestSource(target),
      ).toEqual(source);
    }
    expect((await client.guestSource(target))!.artifact!.revision).toBe(source.artifact!.revision);
  } finally {
    for (const upload of uploads) upload.close();
    await Promise.allSettled(uploads.map((upload) => upload.done));
    forwarding.kill("SIGTERM");
    await stopped;
  }
}
