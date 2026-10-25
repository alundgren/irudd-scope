import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { GuestAddress, GuestEndpoint } from "@irudd-scope/protocol/guest";

export class GuestNetworkError extends Error {}
const NodeStatus = Schema.Struct({ TailscaleIPs: Schema.Array(Schema.String) });
const Status = Schema.Struct({
  BackendState: Schema.String,
  Self: NodeStatus,
  Peer: Schema.Record(Schema.String, NodeStatus),
});

async function installedStatus(signal: AbortSignal): Promise<unknown> {
  const candidates = [
    "tailscale",
    ...(process.platform === "darwin"
      ? [
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          "/usr/local/bin/tailscale",
          "/opt/homebrew/bin/tailscale",
        ]
      : process.platform === "win32"
        ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe")]
        : ["/usr/bin/tailscale", "/usr/local/bin/tailscale"]),
  ];
  for (const executable of candidates) {
    signal.throwIfAborted();
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          executable,
          ["status", "--json"],
          {
            signal,
            // The macOS app also contains the CLI; desktop launches have no terminal environment.
            env: { ...process.env, TAILSCALE_BE_CLI: "1" },
            timeout: 5000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      });
      return JSON.parse(output) as unknown;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new GuestNetworkError(
        error instanceof SyntaxError
          ? "Scope could not read Tailscale's status response. Retry guest pairing."
          : "Scope could not run Tailscale's status command. Retry guest pairing.",
      );
    }
  }
  throw new GuestNetworkError(
    "Scope could not find the Tailscale command. Check that Tailscale is installed in its usual location, then retry.",
  );
}

export class GuestNetwork {
  private readonly status: typeof installedStatus;
  private readonly interfaces: typeof networkInterfaces;
  constructor(status = installedStatus, interfaces = networkInterfaces) {
    this.status = status;
    this.interfaces = interfaces;
  }

  async discover(signal: AbortSignal) {
    signal.throwIfAborted();
    let status: typeof Status.Type;
    try {
      // Installed CLI output includes version-dependent metadata outside the fields we consume.
      status = Schema.decodeUnknownSync(Status, { onExcessProperty: "ignore" })(
        await this.status(signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GuestNetworkError) throw error;
      throw new GuestNetworkError(
        "Scope could not read Tailscale's status response. Retry guest pairing.",
      );
    }
    signal.throwIfAborted();
    if (status.BackendState !== "Running")
      throw new GuestNetworkError(
        "Tailscale is not connected. Open Tailscale and connect to your tailnet, then retry.",
      );
    const address = status.Self.TailscaleIPs.find((ip) => Schema.is(GuestAddress)(ip));
    if (
      !address ||
      !Object.values(this.interfaces()).some((entries) =>
        entries?.some(
          (entry) => entry.family === "IPv4" && !entry.internal && entry.address === address,
        ),
      )
    )
      throw new GuestNetworkError(
        "The local Tailscale IPv4 interface is unavailable. Reconnect Tailscale, then retry.",
      );
    return {
      address,
      peers: new Set(
        Object.values(status.Peer)
          .flatMap((peer) => peer.TailscaleIPs)
          .filter(Schema.is(GuestAddress)),
      ),
    };
  }

  async peer(endpoint: GuestEndpoint, signal: AbortSignal) {
    let validated: GuestEndpoint;
    try {
      validated = decode(GuestEndpoint, endpoint);
    } catch {
      throw new GuestNetworkError(
        "Invalid guest destination. Create a new guest invitation in Other Scopes.",
      );
    }
    const network = await this.discover(signal);
    if (validated.address === network.address || !network.peers.has(validated.address))
      throw new GuestNetworkError(
        "Invalid guest destination: this address is not a Tailscale peer. Create a new guest invitation in Other Scopes.",
      );
    return { endpoint: validated, localAddress: network.address };
  }
}
