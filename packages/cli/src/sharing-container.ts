import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";

export const sharingContainer = "irudd-scope-sharing";
export const sharingNetwork = "irudd-scope-sharing";
export const sharingVolume = "irudd-scope-sharing-data";
const marker = "io.irudd-scope.sharing";
const caps = ["CHOWN", "NET_ADMIN", "SETGID", "SETUID", "SETPCAP"];
const proxies = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
let dockerHost: string | undefined;

export function sharingCommand(
  program: string,
  args: string[],
  input = "",
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      program,
      program === "docker" && dockerHost ? ["--host", dockerHost, ...args] : args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env:
          program === "docker" && dockerHost
            ? { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined }
            : process.env,
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (data) => {
      stdout += data;
      if (stdout.length > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-8192);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `${program} failed or timed out.`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const docker = (args: string[]) => sharingCommand("docker", args);
export async function localDocker() {
  dockerHost = undefined;
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Sharing requires macOS or Linux with a local Docker engine.");
  const context = JSON.parse(await docker(["context", "inspect"])) as {
    Endpoints: { docker: { Host: string } };
  }[];
  const host = process.env.DOCKER_CONTEXT
    ? context[0]?.Endpoints.docker.Host
    : (process.env.DOCKER_HOST ?? context[0]?.Endpoints.docker.Host);
  if (!host?.startsWith("unix://"))
    throw new Error(
      "Sharing requires a local Docker socket. Remote Docker contexts are not supported.",
    );
  dockerHost = host;
  const version = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (Number(version.split(".")[0]) < 28)
    throw new Error("Update Docker to version 28 or later before installing sharing.");
}

type Container = {
  State: { Running: boolean };
  Image: string;
  Path: string;
  Args: string[];
  Config: { Labels: Record<string, string>; Env: string[]; Entrypoint: string[] };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
  HostConfig: {
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapAdd: string[];
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    PidMode: string;
    IpcMode: string;
    CgroupnsMode: string;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number;
    Binds: string[] | null;
    Devices: unknown[] | null;
    VolumesFrom: unknown[] | null;
    ExtraHosts: unknown[] | null;
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
    Tmpfs: Record<string, string>;
    Sysctls: Record<string, string>;
  };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
};
export async function inspectSharing(): Promise<Container | undefined> {
  const ids = await docker([
    "container",
    "ls",
    "-a",
    "--filter",
    `name=^/${sharingContainer}$`,
    "--format",
    "{{.ID}}",
  ]);
  if (!ids) return;
  const info = (JSON.parse(await docker(["inspect", sharingContainer])) as Container[])[0];
  if (info.Config.Labels?.[marker] !== "1")
    throw new Error("The container name belongs to another installation.");
  return info;
}

export function checkContainer(info: Container) {
  const config = info.HostConfig;
  const ports = config.PortBindings;
  const bindings = ports["43131/tcp"];
  const capNames = (values: string[]) =>
    values
      .map((value) => value.replace(/^CAP_/, ""))
      .sort()
      .join(",");
  const valid =
    config.ReadonlyRootfs &&
    !config.Privileged &&
    capNames(config.CapAdd) === [...caps].sort().join(",") &&
    capNames(config.CapDrop) === "ALL" &&
    config.SecurityOpt?.length === 1 &&
    config.SecurityOpt[0] === "no-new-privileges" &&
    config.NetworkMode === sharingNetwork &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    config.CgroupnsMode === "private" &&
    config.Memory === 768 * 1024 * 1024 &&
    config.MemorySwap === 768 * 1024 * 1024 &&
    config.NanoCpus === 1_000_000_000 &&
    config.PidsLimit === 128 &&
    !config.Binds?.length &&
    !config.Devices?.length &&
    !config.VolumesFrom?.length &&
    !!config.ExtraHosts?.length &&
    config.ExtraHosts.every(
      (value) =>
        typeof value === "string" && /^api\.trycloudflare\.com:\d+\.\d+\.\d+\.\d+$/.test(value),
    ) &&
    Object.keys(ports).length === 1 &&
    bindings?.length === 1 &&
    bindings[0].HostIp === "127.0.0.1" &&
    Object.keys(info.NetworkSettings.Networks).length === 1 &&
    Object.keys(config.Tmpfs).length === 1 &&
    config.Tmpfs["/tmp"] === "rw,noexec,nosuid,nodev,size=32m,mode=1777" &&
    info.Mounts.every(
      (mount) =>
        (mount.Type === "volume" &&
          mount.Name === sharingVolume &&
          mount.Destination === "/data" &&
          mount.RW) ||
        (mount.Type === "tmpfs" && mount.Destination === "/tmp") ||
        (mount.Type === "bind" && mount.Destination === "/etc/resolv.conf" && !mount.RW),
    ) &&
    info.Mounts.some((mount) => mount.Name === sharingVolume) &&
    config.Sysctls["net.ipv4.ip_unprivileged_port_start"] === "0" &&
    JSON.stringify(info.Config.Entrypoint) ===
      JSON.stringify(["/usr/local/bin/node", "/app/bootstrap.mjs"]);
  if (
    !valid ||
    info.Config.Env.some(
      (value) =>
        !["PATH", "NODE_VERSION", "YARN_VERSION", ...proxies].includes(value.split("=")[0]),
    ) ||
    info.Config.Env.some((value) =>
      proxies.some((key) => value.startsWith(`${key}=`) && value !== `${key}=`),
    )
  )
    throw new Error(
      "The installed sharing container does not have the required restrictions. Remove it and install it again.",
    );
}

export async function sharingControl(action: string, body: unknown = {}) {
  const output = await sharingCommand(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "65532:65532",
      sharingContainer,
      "/usr/local/bin/node",
      "/app/main.mjs",
      "control",
      action,
    ],
    JSON.stringify(body),
  );
  return JSON.parse(output);
}

export async function verifySharing() {
  const info = await inspectSharing();
  if (!info?.State.Running)
    throw new Error("The sharing service is stopped. Run irudd-scope sharing start.");
  checkContainer(info);
  const directory = await mkdtemp(join(tmpdir(), "scope-sharing-check-"));
  const path = join(directory, "host-only");
  const canary = createServer((socket) => socket.end("restriction probe"));
  try {
    await writeFile(path, "synthetic host file", { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      canary.once("error", reject);
      canary.listen(0, "0.0.0.0", resolve);
    });
    const address = canary.address();
    if (!address || typeof address === "string")
      throw new Error("Could not prepare a network restriction check.");
    const source = `const dns = require("node:dns").promises; const net = require("node:net");
      (async () => { const {address} = await dns.lookup("host.docker.internal", {family:4});
        await new Promise((resolve,reject) => { const s=net.connect(${address.port},address); s.setTimeout(2000,()=>s.destroy(new Error("Host probe unreachable"))); s.on("error",reject); s.once("data",()=>{s.destroy();resolve()}); });
        await new Promise((resolve,reject) => { const s=net.connect(43131,${JSON.stringify(info.NetworkSettings.Networks[sharingNetwork].IPAddress)}); s.setTimeout(800,()=>{s.destroy();resolve()}); s.on("error",resolve); s.on("connect",()=>{s.destroy();reject(new Error("Management is reachable from another container"))}); });
        console.log(address);
      })().catch(error=>{console.error(error.message);process.exit(1)});`;
    const host = await docker([
      "run",
      "--rm",
      "--network",
      sharingNetwork,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65532:65532",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--entrypoint",
      "/usr/local/bin/node",
      info.Image,
      "-e",
      source,
    ]);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host))
      throw new Error("Could not verify host network isolation.");
    await sharingControl("verify", { port: address.port, host, path });
    const port = info.HostConfig.PortBindings["43131/tcp"][0].HostPort;
    const response = await fetch(`http://127.0.0.1:${port}/v1/shares`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (response.status !== 401)
      throw new Error("The private management listener did not require authentication.");
  } finally {
    canary.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createSharing(
  image: string,
  port: number,
  resolver: string,
  endpoint = `http://127.0.0.1:${port}`,
) {
  for (const [kind, name] of [
    ["network", sharingNetwork],
    ["volume", sharingVolume],
  ]) {
    const present = await docker([
      kind,
      "ls",
      "--filter",
      `name=^${name}$`,
      "--format",
      "{{.Name}}",
    ]);
    if (present) {
      const [info] = JSON.parse(await docker([kind, "inspect", name]));
      if (
        info.Labels?.[marker] !== "1" ||
        (kind === "volume" &&
          (info.Driver !== "local" || Object.keys(info.Options ?? {}).length)) ||
        (kind === "network" && (info.Driver !== "bridge" || info.EnableIPv6))
      )
        throw new Error(
          `The ${kind} name belongs to another installation or has unsupported settings.`,
        );
    } else
      await docker([
        kind,
        "create",
        "--label",
        `${marker}=1`,
        ...(kind === "network" ? ["--driver", "bridge"] : []),
        name,
      ]);
  }
  const api = [
    ...new Set(
      (await lookup("api.trycloudflare.com", { family: 4, all: true })).map((item) => item.address),
    ),
  ];
  if (!api.length || api.length > 16) throw new Error("Could not resolve the Quick Tunnel API.");
  await docker([
    "create",
    "--name",
    sharingContainer,
    "--label",
    `${marker}=1`,
    "--restart",
    "unless-stopped",
    "--read-only",
    "--label",
    `${marker}.endpoint=${endpoint}`,
    "--cap-drop",
    "ALL",
    ...caps.flatMap((cap) => ["--cap-add", cap]),
    "--security-opt",
    "no-new-privileges",
    "--network",
    sharingNetwork,
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--memory",
    "768m",
    "--memory-swap",
    "768m",
    "--pids-limit",
    "128",
    "--cpus",
    "1",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    "--sysctl",
    "net.ipv4.ip_unprivileged_port_start=0",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777",
    "--mount",
    `type=volume,src=${sharingVolume},dst=/data`,
    "--publish",
    `127.0.0.1:${port}:43131`,
    "--mount",
    `type=bind,src=${resolver},dst=/etc/resolv.conf,readonly`,
    ...api.flatMap((address) => ["--add-host", `api.trycloudflare.com:${address}`]),
    ...proxies.flatMap((key) => ["--env", `${key}=`]),
    image,
  ]);
  checkContainer((await inspectSharing())!);
}

export async function startSharing() {
  await docker(["start", sharingContainer]);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await verifySharing();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await docker(["stop", "--time", "3", sharingContainer]);
  throw new Error(
    "The sharing service could not pass its startup checks. Inspect docker logs irudd-scope-sharing. The service was stopped.",
  );
}
