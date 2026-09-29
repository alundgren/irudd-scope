import { readFile, writeFile, access } from "node:fs/promises";
import { connect } from "node:net";
import { createSocket } from "node:dgram";

export async function assertProcess(pid = "self") {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  if (
    !/^Uid:\s+65532\s+65532\s+65532\s+65532$/m.test(status) ||
    !/^NoNewPrivs:\s+1$/m.test(status) ||
    !/^Seccomp:\s+2$/m.test(status) ||
    ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].some(
      (name) => !new RegExp(`^${name}:\\s+0+$`, "m").test(status),
    )
  )
    throw new Error(
      "Sharing requires an unprivileged process with no capabilities, no-new-privileges, and seccomp.",
    );
}

function tcpBlocked(host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const finish = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(800, finish);
    socket.once("error", finish);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("An unrelated network destination was reachable."));
    });
  });
}

async function dnsBlocked() {
  const socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 800);
      socket.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("message", () => {
        clearTimeout(timeout);
        reject(new Error("The unrestricted Docker resolver was reachable."));
      });
      socket.send(
        Buffer.from("12ab01000001000000000000076578616d706c6503636f6d0000010001", "hex"),
        53,
        "127.0.0.11",
      );
    });
  } finally {
    socket.close();
  }
}

export async function verifyContainment(
  canaryPort?: number,
  canaryPath?: string,
  canaryHost?: string,
) {
  await assertProcess();
  if (process.pid !== 1) throw new Error("The sharing service must own its PID namespace.");
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  if (
    !mounts
      .split("\n")
      .some((line) => line.split(" ")[4] === "/" && line.split(" ")[5].split(",").includes("ro"))
  )
    throw new Error("The container filesystem must be read-only.");
  for (const path of ["/etc/hosts", "/etc/resolv.conf", "/app/restriction-probe"]) {
    try {
      await writeFile(path, "", { flag: "a" });
    } catch {
      continue;
    }
    throw new Error("The service could write outside its private data directories.");
  }
  for (const path of [
    "/var/run/docker.sock",
    "/run/docker.sock",
    ...(canaryPath ? [canaryPath] : []),
  ]) {
    try {
      await access(path);
    } catch {
      continue;
    }
    throw new Error("Host data was visible inside the sharing container.");
  }
  const gateway = process.env.SCOPE_SHARING_GATEWAY;
  if (!gateway || !/^\d+\.\d+\.\d+\.\d+$/.test(gateway))
    throw new Error("Missing private container gateway.");
  await Promise.all([
    tcpBlocked("1.1.1.1", 443),
    tcpBlocked("169.254.169.254", 80),
    tcpBlocked(canaryHost ?? gateway, canaryPort ?? 43120),
    dnsBlocked(),
  ]);
  return { verified: true as const };
}
