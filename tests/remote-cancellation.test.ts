import { expect, test, vi } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";

test("disconnecting a streamed relay upload settles source cancellation and pending reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-relay-cancel-"));
  const store = new DesktopStore(directory, memoryCredentials());
  await store.load();
  let uploaded: () => void;
  const upload = new Promise<void>((resolve) => (uploaded = resolve));
  let events: ServerResponse | undefined;
  const hub = createServer((request, response) => {
    if (request.url === "/v1/relay/events") {
      events = response;
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write('{"type":"ready"}\n');
    } else if (request.url?.endsWith("/response")) {
      request.resume();
      request.on("end", () => response.end('{"delivered":true}'));
    } else response.writeHead(404).end();
  });
  hub.listen(0, "127.0.0.1");
  await once(hub, "listening");
  const endpoint = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
  const desktopUrl = `${endpoint}/desktop`;
  const remote = { id: randomUUID(), name: "Synthetic hub", endpoint, enabled: true };
  await store.saveRemote(remote, "synthetic-paired-mac-credential-token");
  const remotes = new Remotes(store, { url: desktopUrl, token: "synthetic-local-token" }, () => {});
  let sourceCanceled = false;
  let cancellationFinished = false;
  const fetch = globalThis.fetch;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const target = input instanceof Request ? input.url : input.toString();
    if (target.startsWith(remote.endpoint) && target.endsWith("/body")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4096));
            },
            cancel() {
              sourceCanceled = true;
              return Promise.reject(new DOMException("Source fetch aborted", "AbortError"));
            },
          }),
        ),
      );
    }
    if (target === `${desktopUrl}/v1/plans`) {
      if (!(init?.body instanceof ReadableStream) || !init.signal)
        throw new Error("The relay must forward a stream with a cancellation signal.");
      const reader = init.body.getReader();
      const signal = init.signal;
      const abort = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return (async () => {
        await reader.read();
        // Hold a read across disconnect so cancellation must also settle the pending read.
        const pending = reader.read();
        uploaded();
        await abort;
        await reader.cancel(signal.reason).then(
          () => {
            cancellationFinished = true;
          },
          () => {},
        );
        await pending;
        reader.releaseLock();
        return new Response("{}");
      })();
    }
    return fetch(input, init);
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await remotes.start();
    await expect.poll(() => remotes.snapshot()[0]?.connection).toBe("connected");
    events!.write(
      JSON.stringify({ type: "request", id: randomUUID(), method: "POST", path: "/v1/plans" }) +
        "\n",
    );
    await upload;
    await remotes.setEnabled(remote.id, false);
    await delay(0);
    expect(sourceCanceled).toBe(true);
    expect(cancellationFinished).toBe(true);
    expect(remotes.snapshot()[0].connection).toBe("disconnected");
    expect(
      errors.mock.calls.filter(
        (call) => typeof call[1] === "string" && call[1].includes('"stage":"body-error"'),
      ),
    ).toEqual([]);
  } finally {
    await remotes.close();
    fetchMock.mockRestore();
    errors.mockRestore();
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
