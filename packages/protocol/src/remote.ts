import { Schema } from "effect";
import { decode, validateEndpoint } from "./index.ts";

export const RemoteToken = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{32,128}$/));
export const RemoteId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const RemoteName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const BuildCommit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
export const HubUpdateRequest = Schema.Struct({
  commit: BuildCommit,
  retry: Schema.optionalKey(Schema.Boolean),
});
export type HubUpdateRequest = typeof HubUpdateRequest.Type;
export const HubUpdateStatus = Schema.Struct({
  supported: Schema.Boolean,
  phase: Schema.Literals(["idle", "building", "restarting", "error"]),
  currentCommit: Schema.optionalKey(BuildCommit),
  targetCommit: Schema.optionalKey(BuildCommit),
  message: Schema.String.check(Schema.isMaxLength(2048)),
  output: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export type HubUpdateStatus = typeof HubUpdateStatus.Type;
export const PairRequest = Schema.Struct({ name: RemoteName });
export const PairReceipt = Schema.Struct({ id: RemoteId, name: RemoteName, token: RemoteToken });
export const HubStatus = Schema.Struct({
  id: RemoteId,
  name: RemoteName,
  endpoint: Schema.String,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  pairedMac: Schema.NullOr(RemoteName),
  connected: Schema.optionalKey(Schema.Boolean),
  commit: Schema.optionalKey(BuildCommit),
});
export type HubStatus = typeof HubStatus.Type;

export async function readRemoteJson(response: Response, limit = 4096): Promise<unknown> {
  if (!response.body) throw new Error("The hub returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("The hub returned an oversized response.");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export const RelayRequest = Schema.Struct({
  type: Schema.Literal("request"),
  id: RemoteId,
  method: Schema.Literals(["GET", "POST", "PUT", "DELETE"]),
  path: Schema.String.check(Schema.isMaxLength(2048)),
  contentType: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type RelayRequest = typeof RelayRequest.Type;
export const RelayEvent = Schema.Union([
  RelayRequest,
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("cancel"), id: RemoteId }),
]);
export type RelayEvent = typeof RelayEvent.Type;

export function maintenanceRequest(path: string): boolean {
  return path === "/v1/maintenance/shrink";
}

export function artifactRequest(method: string, path: string): boolean {
  if (path.length > 2048 || !path.startsWith("/v1/") || /[\r\n#]/.test(path)) return false;
  const url = new URL(path, "http://127.0.0.1");
  if (method === "GET" && ["/v1/events", "/v1/artifacts"].includes(url.pathname)) return true;
  if (method === "POST" && path === "/v1/voice") return true;
  if (/^\/v1\/voice\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(path))
    return method === "GET" || method === "DELETE";
  if (method === "GET" && /^\/v1\/voice\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/result$/.test(path))
    return true;
  if (method === "POST" && /^\/v1\/voice\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/billing$/.test(path))
    return true;
  if (method === "GET" && path === "/v1/maintenance/status") return true;
  if (method === "POST" && ["/v1/diagrams", "/v1/diagram-agents"].includes(path)) return true;
  if (method === "POST" && path === "/v1/diagrams/sync") return true;
  if (method === "POST" && path === "/v1/plans") return true;
  if (
    method === "GET" &&
    /^\/v1\/plans\/[a-z0-9][a-z0-9-]{0,127}\/(?:images\/[a-f0-9]{64}|revisions\/[1-9][0-9]*\/content)$/.test(
      path,
    )
  )
    return true;
  if (method === "GET" && /^\/v1\/names\/[a-z0-9][a-z0-9-]{0,127}$/.test(path)) return true;
  if (method === "POST" && maintenanceRequest(path)) return true;
  if (method === "POST" && /^\/v1\/tabs\/[0-9a-f-]{36}\/blobs$/.test(path)) return true;
  if (method === "POST" && /^\/v1\/artifacts\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/tab$/.test(path))
    return true;
  return (
    /^(?:GET|PUT|DELETE)$/.test(method) &&
    /^\/v1\/artifacts\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}(?:\/content)?$/.test(url.pathname) &&
    !(method !== "GET" && (url.search || url.pathname.endsWith("/content")))
  );
}

export function pairingUrl(endpoint: string, token: string): string {
  return `irudd-scope://pair?endpoint=${encodeURIComponent(validateEndpoint(endpoint))}#${decode(RemoteToken, token)}`;
}

export function readPairingUrl(value: string) {
  try {
    if (value.length > 4096) throw new Error();
    const url = new URL(value.trim());
    if (url.protocol !== "irudd-scope:" || url.hostname !== "pair" || url.username || url.password)
      throw new Error();
    return {
      endpoint: validateEndpoint(url.searchParams.get("endpoint") ?? ""),
      token: decode(RemoteToken, url.hash.slice(1)),
    };
  } catch {
    throw new Error("Paste the complete pairing URL printed by irudd-scope pair.");
  }
}

export async function readRelayEvents(response: Response, onEvent: (event: RelayEvent) => void) {
  if (!response.ok || !response.body)
    throw new Error("The hub refused the connection. Pair again if access was revoked.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("The hub disconnected.");
      pending += value;
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        if (boundary > 8192) throw new Error("The hub sent an oversized event.");
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        onEvent(decode(RelayEvent, JSON.parse(line)));
      }
      if (pending.length > 8192) throw new Error("The hub sent an oversized event.");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
