import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { GuestEndpoint } from "@irudd-scope/protocol/guest";
import { GuestNetwork, GuestNetworkError } from "./tailscale.ts";

export type PeerRequest = {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Uint8Array | Readable;
  signal: AbortSignal;
  deadlineMs: number;
  idleMs: number;
};
export type PeerResponse = { status: number; headers: IncomingHttpHeaders; body: IncomingMessage };
export class GuestTransport {
  private lifetime = new AbortController();
  readonly network: GuestNetwork;
  constructor(network = new GuestNetwork()) {
    this.network = network;
  }

  async close() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
  }

  async request(
    endpoint: GuestEndpoint,
    path: string,
    options: PeerRequest,
  ): Promise<PeerResponse> {
    const body = options.body && "pipe" in options.body ? options.body : undefined;
    const operation = new AbortController();
    const bodyError = () => operation.abort(new Error("Guest upload could not be read."));
    // Own uploads before discovery. destroy() can emit a file error asynchronously.
    if (body && !body.closed) {
      body.once("error", bodyError);
      body.once("close", () => {
        body.removeListener("error", bodyError);
        if (!body.readableEnded) bodyError();
      });
    }
    const signal = AbortSignal.any([options.signal, operation.signal, this.lifetime.signal]);
    let pending: ReturnType<typeof httpRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    const deadline = setTimeout(
      () => operation.abort(new GuestNetworkError("Guest request exceeded its total deadline.")),
      options.deadlineMs,
    );
    const idle = setTimeout(
      () =>
        operation.abort(
          new GuestNetworkError(
            "Guest connection timed out. Check Tailscale access and the guest port, then retry.",
          ),
        ),
      options.idleMs,
    );
    let rejectDiscovery: ((error: unknown) => void) | undefined;
    const abort = () => {
      body?.destroy();
      pending?.destroy(
        signal.reason instanceof Error ? signal.reason : new Error("Guest request cancelled."),
      );
      incoming?.destroy(
        signal.reason instanceof Error ? signal.reason : new Error("Guest request cancelled."),
      );
      rejectDiscovery?.(signal.reason);
    };
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(idle);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (body?.destroyed) throw new Error("Guest upload closed before connecting.");
      if (!/^\/guest\/[a-z][a-z0-9-]{0,63}$/.test(path))
        throw new GuestNetworkError(
          "Invalid guest route. Publishing routes and arbitrary URLs are not available.",
        );
      const destination = await Promise.race([
        this.network.peer(endpoint, signal),
        new Promise<never>((_, reject) => {
          rejectDiscovery = reject;
        }),
      ]);
      rejectDiscovery = undefined;
      signal.throwIfAborted();
      return await new Promise<PeerResponse>((resolve, reject) => {
        pending = httpRequest(
          {
            host: destination.endpoint.address,
            port: destination.endpoint.port,
            localAddress: destination.localAddress,
            family: 4,
            method: options.method ?? "GET",
            path,
            agent: false,
            maxHeaderSize: 16384,
            headers: { ...options.headers, Connection: "close" },
          },
          (response) => {
            incoming = response;
            // Keep cancellation and the total deadline until the response body closes.
            response.once("error", () => {});
            response.once("close", cleanup);
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
              reject(
                new GuestNetworkError("Invalid guest destination: redirects are not allowed."),
              );
              response.destroy();
              pending?.destroy();
              return;
            }
            resolve({
              status: response.statusCode ?? 502,
              headers: response.headers,
              body: response,
            });
          },
        );
        pending.once("error", (error) =>
          reject(
            signal.aborted
              ? signal.reason
              : new GuestNetworkError(
                  ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
                    ? "Guest connection was denied. Check Tailscale access and the guest port."
                    : "Guest connection failed. The other Scope may be offline or its guest port blocked.",
                ),
          ),
        );
        pending.once("close", () => {
          body?.destroy();
          if (!incoming || incoming.destroyed) cleanup();
        });
        pending.once("socket", (socket) => {
          // Socket activity covers both upload and response, including backpressure.
          socket.once("connect", () => clearTimeout(idle));
          socket.setTimeout(options.idleMs, () =>
            operation.abort(new GuestNetworkError("Guest connection was idle for too long.")),
          );
        });
        if (body) body.pipe(pending);
        else pending.end(options.body);
      });
    } catch (error) {
      cleanup();
      body?.destroy();
      pending?.destroy();
      incoming?.destroy();
      throw error;
    }
  }
}
