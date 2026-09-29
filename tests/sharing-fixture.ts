import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SharingStore } from "../apps/sharing/src/store.ts";
import { SharingService, type Connect } from "../apps/sharing/src/service.ts";
import { startManagement } from "../apps/sharing/src/management.ts";
import { sharingPairUrl, type ShareWrite } from "@irudd-scope/protocol/sharing";

export async function sharingFixture(connect?: Connect) {
  const directory = await mkdtemp(join(tmpdir(), "scope-sharing-"));
  const filename = join(directory, "sharing.sqlite");
  const store = new SharingStore(filename);
  const ports: number[] = [];
  const stops: number[] = [];
  const disconnected: (() => void)[] = [];
  let wall = Date.now();
  let elapsed = 1000;
  const service = new SharingService(
    store,
    connect ??
      (async (port, _signal, failed) => {
        ports.push(port);
        disconnected.push(failed);
        return {
          hostname: `synthetic-${port}.trycloudflare.com`,
          stop: async () => {
            stops.push(port);
          },
        };
      }),
    { wall: () => wall, elapsed: () => elapsed },
  );
  const management = await startManagement(service);
  const address = management.address();
  if (!address || typeof address === "string") throw new Error("Missing test management port.");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const pairUrl = () => sharingPairUrl(endpoint, store.pairing(Date.now()));
  let token = "";
  const pair = async () => {
    const response = await fetch(`${endpoint}/v1/pair`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${store.pairing(Date.now())}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Synthetic desktop" }),
    });
    const receipt = await response.json();
    token = receipt.token;
    return receipt;
  };
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers?: Record<string, string>,
  ) =>
    fetch(`${endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = (content = "<h1>Frozen copy</h1>"): ShareWrite => ({
    tabId: randomUUID(),
    title: "Synthetic share",
    mediaType: "text/html",
    operationId: randomUUID(),
    expectedRevision: null,
    content: Buffer.from(content).toString("base64"),
  });
  const close = async () => {
    management.closeAllConnections();
    await new Promise<void>((resolve) => management.close(() => resolve()));
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    filename,
    store,
    service,
    management,
    endpoint,
    ports,
    stops,
    disconnected,
    pairUrl,
    pair,
    request,
    input,
    advance: (wallMs: number, elapsedMs = wallMs) => {
      wall += wallMs;
      elapsed += elapsedMs;
    },
    close,
  };
}
