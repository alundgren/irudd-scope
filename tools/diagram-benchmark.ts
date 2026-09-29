import { createServer, request } from "node:http";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import {
  applyDiagramDelta,
  diagramDelta,
  type NativeDiagram,
} from "@irudd-scope/protocol/diagram-sync";
import { desktopFixture } from "../tests/desktop-fixture.ts";
import { nativeDiagram } from "../tests/fixtures/native-diagram.ts";

type Traffic = {
  requests: number;
  bodyBytes: number;
  headerBytes: number;
  responseBodyBytes: number;
};
const emptyTraffic = (): Traffic => ({
  requests: 0,
  bodyBytes: 0,
  headerBytes: 0,
  responseBodyBytes: 0,
});
const elapsed = (start: number) => Math.round((performance.now() - start) * 100) / 100;

function edit(document: NativeDiagram, index: number): NativeDiagram {
  const next = structuredClone(document);
  const at = (index * 13) % next.elements.length;
  const element = next.elements[at];
  const elements = [...next.elements];
  if (index % 11 === 0) elements.reverse();
  else if (element.type === "text")
    elements[at] = { ...element, text: `Iteration ${index}`, originalText: `Iteration ${index}` };
  else if (element.type === "freedraw" || element.type === "line")
    elements[at] = {
      ...element,
      points: [
        [0, 0],
        [40 + (index % 31), 25],
        [Number(element.width), Number(element.height)],
      ],
    };
  else
    elements[at] = {
      ...element,
      x: Number(element.x) + 3,
      y: Number(element.y) + (index % 2 ? -2 : 2),
      opacity: 60 + (index % 40),
    };
  if (index % 37 === 0) {
    const original = next.elements.find((item) => item.type === "rectangle")!;
    elements.push({
      ...original,
      id: `added-${index}`,
      x: index,
      y: -160,
      groupIds: [],
      boundElements: null,
      frameId: null,
    });
  }
  if (index % 37 === 2) {
    const remove = elements.findIndex((item) => item.id === `added-${index - 2}`);
    if (remove >= 0) elements.splice(remove, 1);
  }
  return { ...next, elements };
}

function comparable(document: NativeDiagram) {
  return {
    ...document,
    elements: document.elements.map(
      ({
        version: _version,
        versionNonce: _nonce,
        updated: _updated,
        seed: _seed,
        index: _index,
        ...element
      }) => element,
    ),
  };
}

async function main() {
  const output = process.argv[2] ?? "/tmp/scope-diagram-benchmark.json";
  const edits = Number(process.env.SCOPE_DIAGRAM_BENCH_EDITS ?? 300);
  if (!Number.isSafeInteger(edits) || edits < 10 || edits > 5000)
    throw new Error("Choose 10–5000 edits.");
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  const page = await application.firstWindow();
  await page.getByRole("button", { name: "Search and controls" }).waitFor();
  const connection = decodeLocalConnection(
    JSON.parse(await readFile(fixture.connectionFile, "utf8")),
  );
  let traffic = emptyTraffic();
  const proxy = createServer((incoming, outgoing) => {
    traffic.requests++;
    traffic.headerBytes += Buffer.byteLength(
      `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${incoming.rawHeaders.reduce((text, value, index) => text + (index % 2 ? `${value}\r\n` : `${value}: `), "")}\r\n`,
    );
    incoming.on("data", (chunk) => {
      traffic.bodyBytes += chunk.length;
    });
    const forwarded = request(
      new URL(incoming.url!, connection.endpoint),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.headers);
        response.on("data", (chunk) => {
          traffic.responseBodyBytes += chunk.length;
        });
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  const client = new ScopeClient(`http://127.0.0.1:${address.port}`, connection.token);
  const human = new ScopeClient(connection.endpoint, connection.token);
  const results: unknown[] = [];
  const start = performance.now();
  try {
    for (const [count, imageBytes] of [
      [24, 0],
      [240, 0],
      [1200, 0],
      [240, 768 * 1024],
    ]) {
      let expected: NativeDiagram | undefined;
      for (const mode of count === 1200 ? ["full", "delta"] : ["delta", "full"]) {
        traffic = emptyTraffic();
        const began = performance.now();
        const id = `bench-${count}-${imageBytes}-${mode}`;
        const source = nativeDiagram(count, imageBytes);
        await client.publish(
          id,
          {
            name: id,
            title: id,
            kind: "excalidraw",
            mediaType: "application/vnd.excalidraw+json",
            fileName: "diagram.excalidraw",
            expectedRevision: 0,
          },
          Buffer.from(JSON.stringify(source)),
        );
        const first = await client.syncDiagram({ action: "read", name: id });
        if (first.type !== "full") throw new Error("Expected initial full model");
        let document = first.document;
        let version = first.version;
        const initialization = { elapsedMs: elapsed(began), ...traffic };
        const latencies: number[] = [];
        let conflicts = 0;
        let responseDeltaBytes = 0;
        const editStart = performance.now();
        for (let index = 0; index < edits; index++) {
          const candidate = edit(document, index);
          if (index > 0 && index % 100 === 0) {
            await human.syncDiagram({
              action: "write",
              name: id,
              expectedVersion: version,
              delta: {
                elements: [],
                deleted: [],
                files: {},
                appState: { set: { viewBackgroundColor: index % 200 ? "#f8f9fa" : "#ffffff" } },
              },
            });
          }
          const then = performance.now();
          const send = (next: NativeDiagram) =>
            client.syncDiagram(
              mode === "delta"
                ? {
                    action: "write",
                    name: id,
                    expectedVersion: version,
                    delta: diagramDelta(document, next),
                  }
                : { action: "replace", name: id, expectedVersion: version, document: next },
            );
          let next = candidate;
          let receipt = await send(next);
          if (receipt.type === "conflict") {
            conflicts++;
            const refresh = await client.syncDiagram({ action: "read", name: id, since: version });
            const local = diagramDelta(document, next);
            if (refresh.type === "full") document = refresh.document;
            else if (refresh.type === "delta")
              document = applyDiagramDelta(document, refresh.delta);
            else throw new Error("Expected fresh model");
            version = refresh.version;
            next = applyDiagramDelta(document, local);
            receipt = await send(next);
          }
          if (receipt.type !== "applied") throw new Error(`Unexpected ${receipt.type}`);
          document = applyDiagramDelta(next, receipt.delta);
          version = receipt.version;
          responseDeltaBytes += Buffer.byteLength(JSON.stringify(receipt.delta));
          latencies.push(elapsed(then));
        }
        const editElapsedMs = elapsed(editStart);
        if (
          expected &&
          JSON.stringify(comparable(document)) !== JSON.stringify(comparable(expected))
        )
          throw new Error(`Full and delta traces diverged for ${count}/${imageBytes}`);
        expected = document;
        const db = new DatabaseSync(join(fixture.settingsDirectory, "artifacts", "scope.db"), {
          readOnly: true,
        });
        const storage = db
          .prepare(
            "SELECT count(*) AS blobs, coalesce(sum(length(content)), 0) AS blobBytes FROM blobs",
          )
          .get();
        db.close();
        const sorted = [...latencies].sort((a, b) => a - b);
        results.push({
          objects: count,
          embeddedSourceBytes: imageBytes,
          mode,
          edits,
          conflicts,
          initialization,
          totalElapsedMs: elapsed(began),
          editElapsedMs,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          traffic: { ...traffic, totalAgentToAppBytes: traffic.bodyBytes + traffic.headerBytes },
          responseDeltaBytes,
          nativeBytes: Buffer.byteLength(JSON.stringify(document)),
          storageBeforeClose: storage,
        });
        await client.delete(id);
        const check = new DatabaseSync(join(fixture.settingsDirectory, "artifacts", "scope.db"), {
          readOnly: true,
        });
        const remaining = check.prepare("SELECT count(*) AS count FROM blobs").get();
        check.close();
        if (remaining?.count !== 0) throw new Error("Closing a benchmark tab left content bytes.");
        process.stderr.write(
          `Finished ${count} objects, ${imageBytes} image bytes, ${mode}: ${editElapsedMs} ms\n`,
        );
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      elapsedMs: elapsed(start),
      method:
        "Identical deterministic native edit traces through real Electron. Agent requests pass through an HTTP/1.1 measuring proxy. Counts include initialization, stale attempts, refresh requests and retries; human simulation requests and deletion are excluded. HTTP headers include request line and CRLF. TLS/TCP framing is excluded. Full mode sends one complete native document per write with the same optimistic protocol. Wall time includes editor normalization, SQLite persistence and transport, without model inference or CLI process startup. Response bytes are traffic, not model context tokens.",
      results,
    };
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, cases: results.length, elapsedMs: report.elapsedMs }));
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

await main();
