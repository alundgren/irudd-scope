import { execFileSync } from "node:child_process";
import { chownSync, chmodSync, readFileSync } from "node:fs";
import { BlockList } from "node:net";
import { regions } from "./network.ts";

function command(program: string, args: string[]) {
  return execFileSync(program, args, { encoding: "utf8", timeout: 10_000 });
}

try {
  if (process.pid !== 1 || process.getuid?.() !== 0)
    throw new Error("Start the service through irudd-scope sharing setup.");
  const gateway = /^default via (\d+\.\d+\.\d+\.\d+) /.exec(
    command("ip", ["-4", "route", "show", "default"]),
  )?.[1];
  if (!gateway) throw new Error("A private container bridge is required.");
  const cloudflare = new BlockList();
  for (const [network, prefix] of [
    ["173.245.48.0", 20],
    ["103.21.244.0", 22],
    ["103.22.200.0", 22],
    ["103.31.4.0", 22],
    ["141.101.64.0", 18],
    ["108.162.192.0", 18],
    ["190.93.240.0", 20],
    ["188.114.96.0", 20],
    ["197.234.240.0", 22],
    ["198.41.128.0", 17],
    ["162.158.0.0", 15],
    ["104.16.0.0", 13],
    ["104.24.0.0", 14],
    ["172.64.0.0", 13],
    ["131.0.72.0", 22],
  ] as const)
    cloudflare.addSubnet(network, prefix);
  const api = readFileSync("/etc/hosts", "utf8")
    .split("\n")
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      return fields.length === 2 && fields[1] === "api.trycloudflare.com" ? [fields[0]] : [];
    });
  if (!api.length || api.length > 16 || api.some((address) => !cloudflare.check(address)))
    throw new Error("Quick Tunnel API did not resolve to Cloudflare addresses.");
  if (
    readFileSync("/etc/resolv.conf", "utf8") !==
    "nameserver 127.0.0.53\noptions timeout:1 attempts:1\n"
  )
    throw new Error("The restricted DNS configuration is required.");
  for (const program of ["iptables", "ip6tables"]) {
    command(program, ["-P", "INPUT", "DROP"]);
    command(program, ["-P", "OUTPUT", "DROP"]);
    command(program, ["-P", "FORWARD", "DROP"]);
    command(program, ["-F"]);
  }
  const allow = (...args: string[]) => command("iptables", args);
  allow("-A", "INPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
  allow("-A", "OUTPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT");
  allow("-A", "INPUT", "-i", "lo", "-s", "127.0.0.1", "-j", "ACCEPT");
  allow("-A", "INPUT", "-i", "lo", "-s", "127.0.0.53", "-j", "ACCEPT");
  allow("-A", "OUTPUT", "-d", "127.0.0.1", "-p", "tcp", "-j", "ACCEPT");
  allow("-A", "OUTPUT", "-d", "127.0.0.53", "-p", "udp", "--dport", "53", "-j", "ACCEPT");
  allow("-A", "INPUT", "-s", gateway, "-p", "tcp", "--dport", "43131", "-j", "ACCEPT");
  for (const address of api)
    allow("-A", "OUTPUT", "-d", address, "-p", "tcp", "--dport", "443", "-j", "ACCEPT");
  for (const address of Object.values(regions).flat())
    allow("-A", "OUTPUT", "-d", address, "-p", "tcp", "--dport", "7844", "-j", "ACCEPT");
  chownSync("/data", 0, 0);
  chmodSync("/data", 0o700);
  chownSync("/data", 65532, 65532);
  // exec preserves PID 1. Its exit kills every connector in the PID namespace.
  process.execve!(
    "/usr/bin/setpriv",
    [
      "setpriv",
      "--reuid=65532",
      "--regid=65532",
      "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--bounding-set=-all",
      "--no-new-privs",
      "/usr/local/bin/node",
      "/app/main.mjs",
      "run",
    ],
    { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", SCOPE_SHARING_GATEWAY: gateway },
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Sharing startup failed.");
  process.exit(1);
}
