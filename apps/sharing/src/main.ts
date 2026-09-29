import { createServer, request } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { sharingEndpoint, sharingPairUrl } from "@irudd-scope/protocol/sharing";
import { SharingStore } from "./store.ts";
import { SharingService, json } from "./service.ts";
import { startManagement } from "./management.ts";
import { connectQuickTunnel } from "./connector.ts";
import { startDns } from "./network.ts";
import { verifyContainment } from "./containment.ts";

const socketPath = "/tmp/control.sock";

async function run() {
  await verifyContainment();
  const dns = await startDns();
  const store = new SharingStore("/data/sharing.sqlite");
  const service = new SharingService(store, connectQuickTunnel);
  const management = await startManagement(service, 43131, "0.0.0.0");
  await unlink(socketPath).catch(() => {});
  const control = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") throw new Error("Expected POST.");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new Error("Control request too large.");
      }
      const input = JSON.parse(body) as Record<string, unknown>;
      if (req.url === "/verify") {
        const port = input.port;
        if (
          port !== undefined &&
          (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)
        )
          throw new Error("Invalid probe port.");
        if (
          input.host !== undefined &&
          (typeof input.host !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(input.host))
        )
          throw new Error("Invalid probe host.");
        json(
          res,
          200,
          await verifyContainment(
            port as number | undefined,
            typeof input.path === "string" ? input.path : undefined,
            input.host as string | undefined,
          ),
        );
      } else if (req.url === "/configure") {
        if (
          typeof input.endpoint !== "string" ||
          (input.name !== undefined && typeof input.name !== "string")
        )
          throw new Error("Invalid service configuration.");
        const endpoint = sharingEndpoint(input.endpoint);
        const name = (input.name ?? hostname()).trim();
        if (!name || name.length > 160)
          throw new Error("Service name must have 1 to 160 characters.");
        store.setSetting("endpoint", endpoint);
        store.setSetting("name", name);
        json(res, 200, { configured: true });
      } else if (req.url === "/pair") {
        const endpoint = store.getSetting("endpoint");
        if (!endpoint) throw new Error("Configure the sharing service first.");
        json(res, 200, {
          pairingUrl: sharingPairUrl(endpoint, store.pairing(Date.now())),
          expiresInMinutes: 10,
        });
      } else if (req.url === "/status") {
        json(res, 200, {
          ...service.status(),
          endpoint: store.getSetting("endpoint"),
          paired: !!store.getSetting("desktop"),
        });
      } else if (req.url === "/unpair") {
        await service.unpair();
        json(res, 200, { unpaired: true });
      } else throw new Error("Unknown control command.");
    })().catch((error) =>
      json(res, 400, { error: error instanceof Error ? error.message : "Control command failed." }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    management.closeAllConnections();
    management.close();
    control.close();
    dns.close();
    await service.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void stop();
  });
  process.on("SIGINT", () => {
    void stop();
  });
  console.log("Sharing service ready.");
}

async function control(action: string) {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 8192) throw new Error("Control request too large.");
  }
  await new Promise<void>((resolve, reject) => {
    const req = request(
      { socketPath, path: `/${action}`, method: "POST", timeout: 15_000 },
      (response) => {
        let output = "";
        response.on("data", (bytes) => {
          output += bytes;
          if (output.length > 128 * 1024) req.destroy(new Error("Control response too large."));
        });
        response.on("end", () => {
          if (response.statusCode !== 200) reject(new Error(JSON.parse(output).error));
          else {
            console.log(output);
            resolve();
          }
        });
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Control command timed out.")));
    req.end(body || "{}");
  });
}

try {
  if (process.argv[2] === "run") await run();
  else if (process.argv[2] === "control" && /^[a-z]+$/.test(process.argv[3] ?? ""))
    await control(process.argv[3]);
  else throw new Error("Install with irudd-scope sharing setup.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Sharing service failed.");
  process.exit(1);
}
