import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

// Opt-in native smoke: uses installed Tailcat and synthetic memory-only keys.
const children = new Set<ChildProcess>();
const entry = resolve("apps/desktop/dist/guest-process.mjs");
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (child.connected) child.disconnect();
    else child.kill();
  });
}
function worker(command: { mode: string; key?: string; port?: number }) {
  const child = fork(entry, [], {
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    serialization: "advanced",
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.add(child);
  const ready = new Promise<{ type: string; key?: string; address?: string; socksPort?: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Guest worker timed out.")), 55000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Guest worker failed. Check Tailcat and protected pipe support."));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.on(
        "message",
        (value: { type: string; key?: string; address?: string; socksPort?: number }) => {
          if (value.type === "error") return fail();
          if (value.type === "key" || value.type === "ready") {
            clearTimeout(timer);
            resolve(value);
          }
        },
      );
      child.send(command);
    },
  );
  return { child, ready };
}
async function request(socksPort: number, address: string, port: number, proof: string) {
  const socket = connect(socksPort, "127.0.0.1");
  socket.setTimeout(25000, () => socket.destroy(new Error("Guest request timed out.")));
  const chunks: Buffer[] = [];
  let stage = 0;
  let pending = Buffer.alloc(0);
  return new Promise<boolean>((resolve, reject) => {
    socket.once("error", () => reject(new Error("Guest request failed.")));
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk: Buffer) => {
      if (stage === 2) {
        chunks.push(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      if (stage === 0 && pending.length >= 2) {
        if (pending[1] !== 0) return socket.destroy(new Error("SOCKS authentication failed."));
        pending = pending.subarray(2);
        stage = 1;
        const hostname = Buffer.from(address);
        if (hostname.length > 255) return socket.destroy(new Error("Address too long."));
        const remotePort = Buffer.alloc(2);
        remotePort.writeUInt16BE(port);
        socket.write(
          Buffer.concat([Buffer.from([5, 1, 0, 3, hostname.length]), hostname, remotePort]),
        );
      }
      if (stage === 1 && pending.length >= 5) {
        if (pending[1] !== 0) return socket.destroy(new Error("SOCKS connection failed."));
        const size = pending[3] === 1 ? 10 : pending[3] === 4 ? 22 : 7 + pending[4]!;
        if (pending.length < size) return;
        chunks.push(pending.subarray(size));
        stage = 2;
        socket.write(
          `GET / HTTP/1.1\r\nHost: peer\r\nAuthorization: Bearer ${proof}\r\nConnection: close\r\n\r\n`,
        );
      }
    });
    socket.once("end", () => resolve(Buffer.concat(chunks).toString().startsWith("HTTP/1.1 200")));
  });
}
const proof = randomBytes(32).toString("base64url");
const server = createServer((request, response) =>
  response.writeHead(request.headers.authorization === "Bearer " + proof ? 200 : 403).end(),
);
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const generation = worker({ mode: "generate" });
  const { key } = await generation.ready;
  await stop(generation.child);
  if (!key) throw new Error("Protected key generation returned no key.");
  let previous: string | undefined;
  for (let i = 0; i < 2; i++) {
    const connection = worker({ mode: "start", key, port });
    const { address, socksPort } = await connection.ready;
    if (!address || !socksPort || (previous && previous !== address))
      throw new Error("Guest address did not survive restart.");
    if (!(await request(socksPort, address, port, proof)))
      throw new Error("Authenticated guest request failed.");
    if (await request(socksPort, address, port, "invalid"))
      throw new Error("Guest endpoint accepted an invalid proof.");
    previous = address;
    await stop(connection.child);
  }
  console.log(
    "PASS: protected key generation/restoration, PSK-preserving SOCKS, stable address after worker restart, and separate application authentication.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Guest transport check failed.");
  process.exitCode = 1;
} finally {
  await Promise.all([...children].map(stop));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
