import { spawn } from "node:child_process";
import type { Connect } from "./service.ts";
import { assertProcess } from "./containment.ts";

export const connectQuickTunnel: Connect = async (port, signal, disconnected) => {
  const child = spawn(
    "/usr/local/bin/cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--edge-ip-version",
      "4",
      "--output",
      "json",
      "--management-diagnostics=false",
      "--metrics",
      "127.0.0.1:0",
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      },
    },
  );
  let stopping = false;
  let exited = false;
  const completion = new Promise<void>((resolve) => {
    child.once("error", () => {
      exited = true;
      resolve();
    });
    child.once("exit", () => {
      exited = true;
      resolve();
      if (!stopping) disconnected();
    });
  });
  const stop = async () => {
    if (exited) return;
    stopping = true;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    await completion;
    clearTimeout(kill);
  };
  const abort = () => {
    void stop();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) void stop();
  try {
    if (!child.pid) throw new Error("Tunnel process did not start.");
    await assertProcess(String(child.pid));
    const hostname = await new Promise<string>((resolve, reject) => {
      let pending = "";
      let hostname: string | undefined;
      let connected = false;
      const timer = setTimeout(() => reject(new Error("Tunnel connection timed out.")), 45_000);
      const receive = (bytes: Buffer) => {
        pending = (pending + bytes.toString("utf8")).slice(-16_384);
        hostname ??= /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(pending)?.[1];
        connected ||= pending.includes("Registered tunnel connection");
        if (hostname && connected) {
          clearTimeout(timer);
          resolve(hostname);
        }
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      void completion.then(() => {
        clearTimeout(timer);
        reject(new Error("Tunnel exited."));
      });
    });
    if (signal.aborted || exited) throw new Error("Tunnel ended.");
    return { hostname, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    void completion.then(() => signal.removeEventListener("abort", abort));
  }
};
