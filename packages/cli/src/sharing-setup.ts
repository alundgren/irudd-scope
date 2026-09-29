import { access } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { sharingEndpoint } from "@irudd-scope/protocol/sharing";
import {
  sharingCommand,
  sharingContainer,
  sharingNetwork,
  sharingVolume,
  localDocker,
  inspectSharing,
  sharingControl,
  verifySharing,
  createSharing,
  startSharing,
  checkContainer,
} from "./sharing-container.ts";

type Options = {
  yes?: boolean;
  port?: string;
  httpsPort?: string;
  name?: string;
  noPair?: boolean;
};
const docker = (args: string[]) => sharingCommand("docker", args);
type Installed = NonNullable<Awaited<ReturnType<typeof inspectSharing>>>;
const tailscale = async (args: string[]) => JSON.parse(await sharingCommand("tailscale", args));
type Serve = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

async function confirm(text: string, yes?: boolean) {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error(`${text} Rerun with --yes to confirm.`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if ((await prompt.question(`${text} Continue? [y/N] `)).toLowerCase() !== "y")
      throw new Error("Canceled.");
  } finally {
    prompt.close();
  }
}
function portNumber(value: string | undefined, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535)
    throw new Error("Sharing ports must be whole numbers from 1024 to 65535.");
  return number;
}
async function privateRoute(port: number, requested?: string, existing?: string) {
  const status = await tailscale(["status", "--json"]);
  const host = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  if (status.BackendState !== "Running" || !/^[a-z0-9.-]+\.ts\.net$/.test(host))
    throw new Error(
      "Connect Tailscale with MagicDNS and HTTPS before installing a VM sharing service.",
    );
  const serve: Serve = await tailscale(["serve", "status", "--json"]);
  let https = portNumber(requested ?? (existing ? new URL(existing).port : undefined), 8460);
  if (!requested && !existing) while (serve.TCP?.[String(https)] && https < 65535) https++;
  const key = `${host}:${https}`;
  const target = `http://127.0.0.1:${port}`;
  const endpoint = sharingEndpoint(`https://${key}`);
  if (serve.AllowFunnel?.[key])
    throw new Error("The selected Tailscale port has Funnel enabled. Use a private Serve port.");
  const handlers = serve.Web?.[key]?.Handlers;
  if (
    serve.TCP?.[String(https)] &&
    (existing !== endpoint ||
      !handlers ||
      Object.keys(handlers).length !== 1 ||
      handlers["/"]?.Proxy !== target)
  )
    throw new Error("That Tailscale Serve port is already in use. Choose another --https-port.");
  for (const [name, web] of Object.entries(serve.Web ?? {})) {
    if (name !== key && Object.values(web.Handlers).some((handler) => handler.Proxy === target))
      throw new Error(
        "Another Tailscale route already forwards this local port. Choose another --port.",
      );
  }
  return { endpoint, https, target, installed: !!serve.TCP?.[String(https)] };
}

async function buildImage() {
  const root = process.env.SCOPE_CLI_ROOT;
  if (!root || !isAbsolute(root))
    throw new Error(
      "Install the standalone irudd-scope CLI before installing the sharing service.",
    );
  const context = join(root, "sharing");
  await access(join(context, "Dockerfile"));
  console.error("Building the sharing service image. This can take several minutes.");
  await sharingCommand(
    "docker",
    ["build", "--pull", "--tag", "irudd-scope-sharing:installed", context],
    "",
    10 * 60_000,
  );
  return {
    image: (
      JSON.parse(await docker(["image", "inspect", "irudd-scope-sharing:installed"])) as {
        Id: string;
      }[]
    )[0].Id,
    resolver: join(context, "resolv.conf"),
  };
}

async function printPairing() {
  await checkPrivateRoute((await inspectSharing())!);
  await verifySharing();
  const result = await sharingControl("pair");
  console.log(
    `Paste this URL in Scope Settings → Public sharing. It expires in 10 minutes and can be used once.\n\n${result.pairingUrl}\n`,
  );
}

async function install(options: Options) {
  if (await inspectSharing())
    throw new Error("A sharing service is already installed. Use sharing start, pair, or update.");
  const port = portNumber(options.port, 43131);
  const route =
    process.platform === "darwin" ? undefined : await privateRoute(port, options.httpsPort);
  const endpoint = route?.endpoint ?? `http://127.0.0.1:${port}`;
  await confirm(
    "Install a separate Docker sharing service and private database on this computer? Public links are created only from Scope after pairing.",
    options.yes,
  );
  const { image, resolver } = await buildImage();
  try {
    await createSharing(image, port, resolver, endpoint);
    await startSharing();
    await sharingControl("configure", { endpoint, name: options.name ?? hostname() });
    if (route)
      await sharingCommand("tailscale", ["serve", "--bg", `--https=${route.https}`, route.target]);
    if (route) await privateRoute(port, String(route.https), endpoint);
  } catch (error) {
    if (await inspectSharing().catch(() => undefined))
      await docker(["stop", "--time", "3", sharingContainer]).catch(() => {});
    throw error;
  }
  console.log("Sharing service installed and restriction checks passed.");
  if (!options.noPair) await printPairing();
}

async function checkPrivateRoute(info: Installed) {
  try {
    const port = Number(info.HostConfig.PortBindings["43131/tcp"]?.[0]?.HostPort);
    const endpoint = sharingEndpoint(info.Config.Labels["io.irudd-scope.sharing.endpoint"]);
    if (process.platform === "darwin") {
      if (endpoint !== `http://127.0.0.1:${port}`)
        throw new Error("Mac sharing management must use host loopback.");
    } else {
      if (!endpoint.startsWith("https:"))
        throw new Error("VM sharing management requires private Tailscale Serve.");
      const route = await privateRoute(port, undefined, endpoint);
      if (!route.installed || route.endpoint !== endpoint)
        throw new Error(
          "The private Tailscale route is missing or changed. Remove the service and set it up again.",
        );
    }
  } catch (error) {
    await docker(["stop", "--time", "3", sharingContainer]).catch(() => {});
    throw error;
  }
}

async function startInstalled(info: Installed) {
  try {
    checkContainer(info);
    await checkPrivateRoute(info);
    await startSharing();
    await checkPrivateRoute(info);
  } catch (error) {
    await docker(["stop", "--time", "3", sharingContainer]).catch(() => {});
    throw error;
  }
}

async function update(options: Options) {
  const info = await inspectSharing();
  if (!info) throw new Error("Install the service with irudd-scope sharing setup first.");
  checkContainer(info);
  await confirm(
    "Updating ends all active public links. The private database and pairing are retained.",
    options.yes,
  );
  await checkPrivateRoute(info);
  const { image, resolver } = await buildImage();
  const port = Number(info.HostConfig.PortBindings["43131/tcp"][0].HostPort);
  await docker(["stop", "--time", "5", sharingContainer]);
  await docker(["rm", sharingContainer]);
  try {
    await createSharing(
      image,
      port,
      resolver,
      info.Config.Labels["io.irudd-scope.sharing.endpoint"],
    );
    await startInstalled((await inspectSharing())!);
  } catch (error) {
    if (await inspectSharing().catch(() => undefined))
      await docker(["stop", "--time", "3", sharingContainer]).catch(() => {});
    throw error;
  }
  console.log("Sharing service updated. Previous public links have ended.");
}

async function remove(options: Options) {
  const info = await inspectSharing();
  await confirm(
    "Removing the sharing service ends all public links and deletes its snapshots and pairing database.",
    options.yes,
  );
  if (info) await docker(["stop", "--time", "5", sharingContainer]);
  const endpoint = info?.Config.Labels["io.irudd-scope.sharing.endpoint"];
  if (endpoint?.startsWith("https:")) {
    const port = Number(info!.HostConfig.PortBindings["43131/tcp"]?.[0]?.HostPort);
    const route = await privateRoute(port, undefined, endpoint);
    if (route.installed)
      await sharingCommand("tailscale", ["serve", `--https=${route.https}`, "off"]);
  }
  const resources: [string, string][] = [];
  for (const [kind, name] of [
    ["volume", sharingVolume],
    ["network", sharingNetwork],
  ]) {
    if (!(await docker([kind, "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"])))
      continue;
    const [resource] = JSON.parse(await docker([kind, "inspect", name]));
    if (resource.Labels?.["io.irudd-scope.sharing"] !== "1")
      throw new Error(`The ${kind} belongs to another installation and was retained.`);
    resources.push([kind, name]);
  }
  if (!info && !resources.length) throw new Error("No sharing service is installed.");
  if (info) await docker(["rm", sharingContainer]);
  for (const [kind, name] of resources) await docker([kind, "rm", name]);
  console.log("Sharing service removed. All public links have ended.");
}

export async function manageSharing(action: string | undefined, options: Options) {
  if (
    !["setup", "pair", "status", "start", "stop", "unpair", "update", "remove"].includes(
      action ?? "",
    )
  )
    throw new Error("Use irudd-scope sharing setup|pair|status|start|stop|unpair|update|remove.");
  await localDocker();
  if (action === "setup") return install(options);
  if (action === "update") return update(options);
  if (action === "remove") return remove(options);
  const info = await inspectSharing();
  if (!info) throw new Error("Install the service with irudd-scope sharing setup first.");
  if (action === "start") {
    await startInstalled(info);
    console.log("Sharing service started. Previous public links are not recreated.");
    return;
  }
  if (action === "stop") {
    await confirm("Stopping the service ends all active public links.", options.yes);
    await docker(["stop", "--time", "5", sharingContainer]);
    console.log("Sharing service stopped. Public links have ended.");
    return;
  }
  checkContainer(info);
  if (action === "pair") return printPairing();
  if (action === "status" && !info.State.Running) {
    console.log(JSON.stringify({ running: false }));
    return;
  }
  if (action === "unpair")
    await confirm(
      "Unpairing revokes desktop access and ends all active public links.",
      options.yes,
    );
  console.log(JSON.stringify(await sharingControl(action!), null, 2));
}
