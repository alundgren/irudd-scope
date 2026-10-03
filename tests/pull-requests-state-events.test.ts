import { expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ScopeClient } from "@irudd-scope/protocol/client";

test("the event client receives a burst of large valid inbox state edits", async () => {
  const controller = new AbortController();
  const received: number[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      [1, 2, 3, 4, 5, 6]
        .map(
          (version) =>
            `data: ${JSON.stringify({
              type: "pull-requests",
              id: "state-inbox",
              name: "state-inbox",
              generation: version,
              stateChange: { operation: "patch", version, value: { text: "x".repeat(32_000) } },
            })}\n\n`,
        )
        .join(""),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await new ScopeClient(`http://127.0.0.1:${port}`, "synthetic-event-token").watch((event) => {
      if (event.type === "pull-requests" && event.stateChange)
        received.push(event.stateChange.version);
      if (received.length === 6) controller.abort();
    }, controller.signal);
    expect(received).toEqual([1, 2, 3, 4, 5, 6]);
  } finally {
    controller.abort();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
