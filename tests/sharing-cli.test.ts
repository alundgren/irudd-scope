import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function installedContainer() {
  return {
    State: { Running: false },
    Config: {
      Labels: {
        "io.irudd-scope.sharing": "1",
        "io.irudd-scope.sharing.endpoint": "https://synthetic.example.ts.net:8460",
      },
      Env: [],
      Entrypoint: ["/usr/local/bin/node", "/app/bootstrap.mjs"],
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: ["CHOWN", "NET_ADMIN", "SETGID", "SETUID", "SETPCAP"],
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: "irudd-scope-sharing",
      PidMode: "",
      IpcMode: "private",
      CgroupnsMode: "private",
      Memory: 805306368,
      MemorySwap: 805306368,
      NanoCpus: 1000000000,
      PidsLimit: 128,
      Binds: null,
      Devices: null,
      VolumesFrom: null,
      ExtraHosts: ["api.trycloudflare.com:104.16.0.1"],
      PortBindings: { "43131/tcp": [{ HostIp: "127.0.0.1", HostPort: "43131" }] },
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=32m,mode=1777" },
      Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
    },
    NetworkSettings: { Networks: { "irudd-scope-sharing": { IPAddress: "172.18.0.2" } } },
    Mounts: [
      {
        Type: "volume",
        Name: "irudd-scope-sharing-data",
        Source: "/synthetic/data",
        Destination: "/data",
        RW: true,
      },
      {
        Type: "bind",
        Source: "/synthetic/resolv.conf",
        Destination: "/etc/resolv.conf",
        RW: false,
      },
    ],
  };
}

type Command = { program: string; args: string[]; context?: string; host?: string };
async function fixture(
  options: {
    contextHost?: string;
    container?: ReturnType<typeof installedContainer> | null;
    serve?: unknown;
    tailscaleRunning?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "scope-sharing-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state.json");
  const log = join(directory, "commands.jsonl");
  await writeFile(
    state,
    JSON.stringify({
      contextHost: "unix:///synthetic/docker.sock",
      container: installedContainer(),
      serve: {},
      tailscaleRunning: true,
      ...options,
    }),
  );
  const executable = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const program = path.basename(process.argv[1]), raw = process.argv.slice(2);
fs.appendFileSync(process.env.SCOPE_TEST_LOG, JSON.stringify({program, args:raw, context:process.env.DOCKER_CONTEXT, host:process.env.DOCKER_HOST})+"\\n");
const args = raw[0] === "--host" ? raw.slice(2) : raw;
const state = JSON.parse(fs.readFileSync(process.env.SCOPE_TEST_STATE,"utf8"));
const result = value => console.log(typeof value === "string" ? value : JSON.stringify(value));
if(program === "docker") {
  if(args[0] === "context") result([{Endpoints:{docker:{Host:state.contextHost}}}]);
  else if(args[0] === "version") result("29.0.0");
  else if(args[0] === "container") result(state.container ? "synthetic-container" : "");
  else if(args[0] === "inspect") result([state.container]);
  else if(["volume","network"].includes(args[0]) && args[1] === "ls") result(args[0] === "volume" ? "irudd-scope-sharing-data" : "irudd-scope-sharing");
  else if(["volume","network"].includes(args[0]) && args[1] === "inspect") result([{Labels:{"io.irudd-scope.sharing":"1"}}]);
  else if(["stop","rm","volume","network"].includes(args[0])) result("");
  else throw new Error("Unexpected Docker operation "+args[0]);
} else if(args[0] === "status") result({BackendState:state.tailscaleRunning?"Running":"Stopped",Self:{DNSName:"synthetic.example.ts.net."}});
else if(args[0] === "serve" && args[1] === "status") result(state.serve);
else if(args[0] === "serve" && args.at(-1) === "off") result("");
else throw new Error("Unexpected Tailscale operation");
`;
  for (const program of ["docker", "tailscale"])
    await writeFile(join(directory, program), executable, { mode: 0o755 });
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), "sharing", ...args], {
      env: {
        ...process.env,
        DOCKER_HOST: undefined,
        DOCKER_CONTEXT: undefined,
        ...env,
        PATH: `${directory}:${process.env.PATH}`,
        SCOPE_TEST_STATE: state,
        SCOPE_TEST_LOG: log,
      },
      timeout: 10000,
    });
  const commands = async (): Promise<Command[]> =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { cli, commands };
}

test("the selected remote Docker context cannot be hidden by a local DOCKER_HOST", async () => {
  const f = await fixture({ contextHost: "ssh://remote.invalid" });
  await expect(
    f.cli(["status"], { DOCKER_CONTEXT: "remote", DOCKER_HOST: "unix:///local.sock" }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("Remote Docker contexts are not supported"),
  });
  expect((await f.commands()).map((command) => command.args[0])).toEqual(["context"]);
});

test("all Docker operations stay pinned to the verified local context", async () => {
  const f = await fixture();
  expect(
    JSON.parse(
      (await f.cli(["status"], { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://ignored.invalid" }))
        .stdout,
    ),
  ).toEqual({ running: false });
  const commands = await f.commands();
  for (const command of commands.slice(1)) {
    expect(command.args.slice(0, 2)).toEqual(["--host", "unix:///synthetic/docker.sock"]);
    expect(command.context).toBeUndefined();
    expect(command.host).toBeUndefined();
  }
});

test("an unexpectedly public management binding prevents starting the service", async () => {
  const container = installedContainer();
  container.HostConfig.PortBindings["43131/tcp"][0].HostIp = "0.0.0.0";
  const f = await fixture({ container });
  await expect(f.cli(["start"])).rejects.toMatchObject({
    stderr: expect.stringContaining("required restrictions"),
  });
  expect((await f.commands()).some((command) => command.args.includes("start"))).toBe(false);
  expect((await f.commands()).some((command) => command.args.includes("stop"))).toBe(true);
});

test.skipIf(process.platform !== "linux")(
  "setup refuses a Funnel port before building or starting a service",
  async () => {
    const f = await fixture({
      container: null,
      serve: { AllowFunnel: { "synthetic.example.ts.net:8460": true } },
    });
    await expect(f.cli(["setup", "--yes", "--https-port", "8460"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Funnel enabled"),
    });
    expect((await f.commands()).some((command) => command.args.includes("build"))).toBe(false);
  },
);

test.each([false, true])(
  "removing a stopped installation handles an owned route being present=%s",
  async (present) => {
    const f = await fixture({
      serve: present
        ? {
            TCP: { "8460": { HTTPS: true } },
            Web: {
              "synthetic.example.ts.net:8460": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:43131" } },
              },
            },
          }
        : {},
    });
    expect((await f.cli(["remove", "--yes"])).stdout).toContain("Sharing service removed");
    const commands = await f.commands();
    expect(
      commands
        .filter((command) => command.program === "tailscale" && command.args.at(-1) === "off")
        .map((command) => command.args),
    ).toEqual(present ? [["serve", "--https=8460", "off"]] : []);
    expect(
      commands
        .filter(
          (command) =>
            command.program === "docker" &&
            (command.args.includes("stop") || command.args.includes("rm")),
        )
        .map((command) => command.args.slice(2)),
    ).toEqual([
      ["stop", "--time", "5", "irudd-scope-sharing"],
      ["rm", "irudd-scope-sharing"],
      ["volume", "rm", "irudd-scope-sharing-data"],
      ["network", "rm", "irudd-scope-sharing"],
    ]);
  },
);

test.each(["start", "update", "pair"])(
  "%s refuses a route changed to Funnel and stops the service",
  async (action) => {
    const f = await fixture({ serve: { AllowFunnel: { "synthetic.example.ts.net:8460": true } } });
    await expect(f.cli([action, "--yes"])).rejects.toMatchObject({
      stderr: expect.stringContaining(
        process.platform === "darwin" ? "host loopback" : "Funnel enabled",
      ),
    });
    const commands = await f.commands();
    expect(commands.some((command) => command.args.includes("stop"))).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.args.includes("start") ||
          command.args.includes("build") ||
          command.args.includes("exec"),
      ),
    ).toBe(false);
  },
);

test("removal stops public links before a Tailscale failure and retains the container for retry", async () => {
  const f = await fixture({ tailscaleRunning: false });
  await expect(f.cli(["remove", "--yes"])).rejects.toMatchObject({
    stderr: expect.stringContaining("Connect Tailscale"),
  });
  const commands = await f.commands();
  const stopped = commands.findIndex((command) => command.args.includes("stop"));
  const tailscale = commands.findIndex((command) => command.program === "tailscale");
  expect(stopped).toBeGreaterThan(-1);
  expect(stopped).toBeLessThan(tailscale);
  expect(commands.some((command) => command.args.includes("rm"))).toBe(false);
});

test("a service rejected by restriction checks can still be stopped and removed", async () => {
  const container = installedContainer();
  container.HostConfig.ReadonlyRootfs = false;
  const f = await fixture({ container });
  expect((await f.cli(["stop", "--yes"])).stdout).toContain("Sharing service stopped");
  expect((await f.cli(["remove", "--yes"])).stdout).toContain("Sharing service removed");
});

test("removal can retry cleanup of owned resources after the container was removed", async () => {
  const f = await fixture({ container: null });
  expect((await f.cli(["remove", "--yes"])).stdout).toContain("Sharing service removed");
  expect(
    (await f.commands())
      .filter((command) => command.args.includes("rm"))
      .map((command) => command.args.slice(2)),
  ).toEqual([
    ["volume", "rm", "irudd-scope-sharing-data"],
    ["network", "rm", "irudd-scope-sharing"],
  ]);
});
