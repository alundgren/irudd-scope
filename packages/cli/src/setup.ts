import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Schema } from "effect";
import {
  ShrinkReceipt,
  ShrinkRequest,
  MaintenanceStatus,
  MAX_MAINTENANCE_TIMEOUT_MS,
} from "@irudd-scope/protocol/maintenance";
import { HubStatus, readRemoteJson, readPairingUrl } from "@irudd-scope/protocol/remote";
import {
  decode,
  decodeLocalConnection,
  DEFAULT_CONNECTION_FILE,
  DEFAULT_PORT,
} from "@irudd-scope/protocol";

const exec = promisify(execFile);
const unitName = "irudd-scope-hub.service";
const unitMarker = "# Managed by irudd-scope setup\n";
const userDirectory = () => process.env.SCOPE_SETUP_HOME ?? homedir();
const directory = () =>
  process.env.SCOPE_HUB_DATA_DIR ?? join(homedir(), ".local/share/irudd-scope/hub");
const connectionFile = () =>
  process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE);
const serviceFile = () => join(userDirectory(), ".config/systemd/user", unitName);
const quoteUnit = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
const installation = () => {
  const root = process.env.SCOPE_CLI_ROOT;
  if (!root || !isAbsolute(root))
    throw new Error("Use the standalone CLI installer before running remote setup.");
  return root;
};

async function command(file: string, args: string[]) {
  return exec(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
}
async function configureServe(args: string[]) {
  try {
    await command("tailscale", ["serve", ...args]);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Tailscale Serve could not apply this change.";
    throw new Error(
      `${message}\nIf Serve requires administrator permission, run:\n  sudo tailscale serve ${args.join(" ")}\nThen retry this Scope command. The local hub installation is preserved.`,
    );
  }
}
async function fileText(path: string) {
  return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}
async function checkLink(path: string, target: string) {
  const existing = await readlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`${path} already exists. Move it aside before installing the Scope skill.`);
  });
  if (existing !== undefined && existing !== target)
    throw new Error(`${path} belongs to another installation. Move it aside before installing.`);
  return existing;
}
function skillLinks(root: string) {
  const shared = join(userDirectory(), ".agents/skills/irudd-scope");
  return [
    [shared, join(root, "skill")],
    [join(userDirectory(), ".claude/skills/irudd-scope"), shared],
  ] as const;
}
export async function installSkill(remove = false) {
  const root = installation();
  await access(join(root, "skill/SKILL.md"));
  for (const [path, target] of skillLinks(root)) await checkLink(path, target);
  for (const [path, target] of skillLinks(root)) {
    if (remove) {
      if (await checkLink(path, target)) await unlink(path);
    } else {
      await mkdir(dirname(path), { recursive: true });
      if (!(await checkLink(path, target))) await symlink(target, path);
    }
  }
  console.log(remove ? "Scope skill removed." : "Scope skill installed for Codex and Claude Code.");
}

export function hubRequest(action: "status"): Promise<HubStatus>;
export function hubRequest(action: "pair"): Promise<{ url: string; expiresInMinutes: number }>;
export function hubRequest(action: "unpair"): Promise<{ unpaired: true }>;
export async function hubRequest(action: "status" | "pair" | "unpair"): Promise<unknown> {
  const { endpoint, token } = decodeLocalConnection(
    JSON.parse(await readFile(connectionFile(), "utf8")),
  );
  const response = await fetch(`${endpoint}/v1/hub/${action}`, {
    method: action === "status" ? "GET" : "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    throw new Error("The local hub is unavailable. Run irudd-scope hub start and retry.");
  });
  const result = await readRemoteJson(response);
  if (!response.ok) throw new Error(decode(Schema.Struct({ error: Schema.String }), result).error);
  if (action === "status") return decode(HubStatus, result);
  if (action === "unpair") return decode(Schema.Struct({ unpaired: Schema.Literal(true) }), result);
  const pairing = decode(
    Schema.Struct({ url: Schema.String, expiresInMinutes: Schema.Int }),
    result,
  );
  readPairingUrl(pairing.url);
  return pairing;
}

export async function printPairing() {
  const result = await hubRequest("pair");
  console.log(
    `Paste this URL in Scope Settings → Remotes on your Mac. It expires in 10 minutes and can be used once.\n\n${result.url}\n`,
  );
}

type SetupOptions = {
  yes?: boolean;
  httpsPort?: string;
  port?: string;
  noPair?: boolean;
};
const ServeStatus = Schema.Struct({
  TCP: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const ServeWeb = Schema.Struct({
  Handlers: Schema.Record(
    Schema.String,
    Schema.Struct({ Proxy: Schema.optionalKey(Schema.String) }),
  ),
});

async function inspectSetupEnvironment(root: string) {
  if (process.platform !== "linux")
    throw new Error("Remote setup currently requires Linux with a systemd user service.");
  for (const path of [root, directory(), connectionFile(), serviceFile()])
    if (!isAbsolute(path) || /[\r\n]/.test(path))
      throw new Error("Scope paths must be absolute and on one line.");
  await command("systemctl", ["--user", "show-environment"]);
  const linger = (
    await command("loginctl", ["show-user", userInfo().username, "-p", "Linger", "--value"])
  ).stdout.trim();
  if (linger !== "yes")
    throw new Error(
      `Enable your user service after logout with loginctl enable-linger ${userInfo().username}, then retry setup.`,
    );
  const status = Schema.decodeUnknownSync(
    Schema.Struct({ BackendState: Schema.String, Self: Schema.Struct({ DNSName: Schema.String }) }),
  )(JSON.parse((await command("tailscale", ["status", "--json"])).stdout));
  const hostname = status.Self.DNSName.replace(/\.$/, "");
  if (status.BackendState !== "Running" || !/^[a-z0-9.-]+\.ts\.net$/.test(hostname))
    throw new Error("Connect Tailscale with MagicDNS and HTTPS enabled, then retry setup.");
  const serve = Schema.decodeUnknownSync(ServeStatus)(
    JSON.parse((await command("tailscale", ["serve", "status", "--json"])).stdout),
  );
  return { hostname, serve };
}

function selectLocalPort(
  requested: string | undefined,
  configured: HubStatus | undefined,
  serve: typeof ServeStatus.Type,
) {
  let port = Number(requested ?? configured?.port ?? DEFAULT_PORT);
  if (requested || configured) return port;
  const reserved = serveTargets(serve);
  while (reserved.has(`http://127.0.0.1:${port}`) && port < 65535) port++;
  return port;
}

function serveTargets(serve: typeof ServeStatus.Type) {
  const reserved = new Set<string>();
  for (const value of Object.values(serve.Web ?? {})) {
    const web = Schema.decodeUnknownSync(ServeWeb)(value);
    for (const handler of Object.values(web.Handlers))
      if (handler.Proxy) reserved.add(handler.Proxy);
  }
  return reserved;
}

function selectHttpsPort(
  requested: string | undefined,
  configured: HubStatus | undefined,
  serve: typeof ServeStatus.Type,
) {
  const oldPort = configured?.endpoint ? new URL(configured.endpoint).port || "443" : undefined;
  let httpsPort = Number(requested ?? oldPort ?? 8450);
  const explicitPort = Boolean(requested || oldPort);
  if (!explicitPort) while (serve.TCP?.[String(httpsPort)] && httpsPort < 65535) httpsPort++;
  return httpsPort;
}

function validateServeRoute(
  configured: HubStatus | undefined,
  serve: typeof ServeStatus.Type,
  endpoint: string,
  target: string,
  hostname: string,
  httpsPort: number,
) {
  if (serve.TCP?.[String(httpsPort)]) {
    const web = Schema.decodeUnknownSync(ServeWeb)(serve.Web?.[`${hostname}:${httpsPort}`]);
    if (
      Object.keys(web.Handlers).length !== 1 ||
      web.Handlers["/"]?.Proxy !== target ||
      configured?.endpoint !== endpoint
    )
      throw new Error("That Tailscale Serve port is already in use. Choose another --https-port.");
  }
}

function selectSetupPorts(
  options: SetupOptions,
  configured: HubStatus | undefined,
  hostname: string,
  serve: typeof ServeStatus.Type,
) {
  const port = selectLocalPort(options.port, configured, serve);
  const httpsPort = selectHttpsPort(options.httpsPort, configured, serve);
  for (const value of [port, httpsPort])
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error("Ports must be whole numbers from 1 to 65535.");
  const endpoint = `https://${hostname}:${httpsPort}`;
  const target = `http://127.0.0.1:${port}`;
  validateServeRoute(configured, serve, endpoint, target, hostname, httpsPort);
  return { port, httpsPort, endpoint, target };
}

async function confirmSetup(yes: boolean | undefined) {
  if (!yes) {
    if (!process.stdin.isTTY)
      throw new Error("Run setup in a terminal to confirm these changes, or pass --yes.");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(?:es)?$/i.test((await input.question("Continue? [y/N] ")).trim());
    } finally {
      input.close();
    }
  }
  return true;
}

async function waitForHub() {
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      await hubRequest("status").then(
        () => true,
        () => false,
      )
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready)
    throw new Error(
      `The hub did not start. Inspect journalctl --user -u ${unitName}, then rerun setup.`,
    );
}

export async function setup(options: SetupOptions) {
  const root = installation();
  const { hostname, serve } = await inspectSetupEnvironment(root);
  const configured = await access(join(directory(), "hub.db")).then(
    async () =>
      decode(
        HubStatus,
        JSON.parse(
          (await command(join(root, "runtime/node"), [join(root, "hub/main.mjs"), "info"])).stdout,
        ),
      ),
    () => undefined,
  );
  const { port, httpsPort, endpoint, target } = selectSetupPorts(
    options,
    configured,
    hostname,
    serve,
  );
  const existingUnit = await fileText(serviceFile());
  if (existingUnit && !existingUnit.startsWith(unitMarker))
    throw new Error("An unmanaged hub service already exists. Move it aside before setup.");
  if (configured && existingUnit && (configured.endpoint !== endpoint || configured.port !== port))
    throw new Error("Remove the existing hub before changing its endpoint or ports.");
  for (const [path, link] of skillLinks(root)) await checkLink(path, link);
  console.log(
    `Scope setup will run the hub as your user, install its skill for Codex and Claude Code, and publish ${endpoint} through Tailscale Serve.\nHub state: ${directory()}\nCLI discovery: ${connectionFile()}\nService: ${serviceFile()}\nExisting Serve routes will be preserved.`,
  );
  if (!(await confirmSetup(options.yes))) return;
  await command(join(root, "runtime/node"), [
    join(root, "hub/main.mjs"),
    "configure",
    "--endpoint",
    endpoint,
    "--port",
    String(port),
  ]);
  const unit = `${unitMarker}[Unit]\nDescription=Scope publication hub\nAfter=network-online.target\n\n[Service]\nExecStart=${quoteUnit(join(root, "bin/irudd-scope-hub"))}\nEnvironment=${quoteUnit(`SCOPE_HUB_DATA_DIR=${directory()}`)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(dirname(serviceFile()), { recursive: true });
  const temporary = `${serviceFile()}.tmp`;
  await writeFile(temporary, unit, { mode: 0o600 });
  await rename(temporary, serviceFile());
  await chmod(serviceFile(), 0o600);
  await installSkill();
  await command("systemctl", ["--user", "daemon-reload"]);
  await command("systemctl", ["--user", "enable", unitName]);
  await command("systemctl", ["--user", "restart", unitName]);
  if (!serve.TCP?.[String(httpsPort)])
    await configureServe(["--bg", `--https=${httpsPort}`, target]);
  await waitForHub();
  console.log("Hub is running. Scope on your Mac will initiate the connection.");
  const current = await hubRequest("status");
  if (!options.noPair && !current.pairedMac) await printPairing();
  else if (current.pairedMac) console.log("The existing Mac pairing is unchanged.");
}

async function shrinkHub(timeoutMs: number, statusOnly: boolean) {
  const signal = AbortSignal.timeout(timeoutMs);
  const { endpoint, token } = decodeLocalConnection(
    JSON.parse(await readFile(connectionFile(), { encoding: "utf8", signal })),
  );
  const response = await fetch(`${endpoint}/v1/hub/${statusOnly ? "maintenance" : "shrink"}`, {
    method: statusOnly ? "GET" : "POST",
    redirect: "error",
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(statusOnly
      ? {}
      : {
          body: JSON.stringify(
            decode(ShrinkRequest, { timeoutMs: Math.min(timeoutMs, MAX_MAINTENANCE_TIMEOUT_MS) }),
          ),
        }),
  });
  const result = await readRemoteJson(response);
  if (!response.ok) throw new Error(decode(Schema.Struct({ error: Schema.String }), result).error);
  const receipt = statusOnly ? decode(MaintenanceStatus, result) : decode(ShrinkReceipt, result);
  console.log(JSON.stringify(receipt, null, 2));
  if (!statusOnly && receipt.databases.some((database) => database.status !== "completed"))
    process.exitCode = 1;
}

export async function manageHub(
  action: string | undefined,
  timeoutMs = 10_000,
  statusOnly = false,
) {
  if (action === "shrink") {
    await shrinkHub(timeoutMs, statusOnly);
    return;
  }
  if (action === "status") {
    console.log(JSON.stringify(await hubRequest("status"), null, 2));
    return;
  }
  if (action === "unpair") {
    await hubRequest("unpair");
    console.log("Mac access revoked. Run irudd-scope pair to pair again.");
    return;
  }
  if (!["start", "stop", "remove"].includes(action ?? ""))
    throw new Error(
      "Use irudd-scope hub start, stop, status, unpair, remove, shrink, queue, or discard ID.",
    );
  const unit = await fileText(serviceFile());
  if (!unit?.startsWith(unitMarker))
    throw new Error("No Scope-managed hub service is installed. Run irudd-scope setup.");
  if (action === "remove") {
    await removeHub();
  } else {
    await command("systemctl", ["--user", action!, unitName]);
    console.log(
      action === "start" ? "Hub started." : "Hub stopped. Run irudd-scope hub start to resume.",
    );
  }
}

async function removeHub() {
  const status = await hubRequest("status");
  const url = new URL(status.endpoint!);
  const serve = JSON.parse((await command("tailscale", ["serve", "status", "--json"])).stdout);
  const connection = decodeLocalConnection(JSON.parse(await readFile(connectionFile(), "utf8")));
  const handlers = serve.Web?.[url.host]?.Handlers;
  if (
    handlers &&
    (Object.keys(handlers).length !== 1 || handlers["/"]?.Proxy !== connection.endpoint)
  )
    throw new Error(
      "The hub's Serve route was changed by another tool. Remove that route manually before removing the hub.",
    );
  await hubRequest("unpair");
  if (handlers) await configureServe([`--https=${url.port || "443"}`, "off"]);
  await command("systemctl", ["--user", "disable", "--now", unitName]);
  await unlink(serviceFile());
  await command("systemctl", ["--user", "daemon-reload"]);
  await unlink(connectionFile());
  console.log("Hub service and its Serve route removed. The CLI, skill, and hub settings remain.");
}
