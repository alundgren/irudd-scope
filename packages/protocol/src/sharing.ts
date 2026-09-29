import { Schema } from "effect";
import { decode, MAX_CONTENT_BYTES } from "./index.ts";

export const SHARE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_SHARES = 5;
export const MAX_SHARE_REQUEST_BYTES = Math.ceil(MAX_CONTENT_BYTES / 3) * 4 + 8192;
export const SharingId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const SharingToken = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/));
const title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ShareMediaType = Schema.Literals([
  "text/html",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
export const Share = Schema.Struct({
  id: SharingId,
  tabId: SharingId,
  operationId: SharingId,
  title,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp,
  status: Schema.Literals(["starting", "active", "stopped", "expired", "interrupted", "failed"]),
  url: Schema.NullOr(
    Schema.String.check(
      Schema.isPattern(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[a-zA-Z0-9_-]{43}$/),
    ),
  ),
});
export type Share = typeof Share.Type;
export const ShareWrite = Schema.Struct({
  operationId: SharingId,
  tabId: SharingId,
  title,
  mediaType: ShareMediaType,
  expectedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  content: Schema.String.check(Schema.isMaxLength(Math.ceil(MAX_CONTENT_BYTES / 3) * 4)),
});
export type ShareWrite = typeof ShareWrite.Type;
export const SharingStatus = Schema.Struct({
  version: Schema.Literal(1),
  id: SharingId,
  name: title,
  shares: Schema.Array(Share).check(Schema.isMaxLength(128)),
});
export type SharingStatus = typeof SharingStatus.Type;
export const SharingPairReceipt = Schema.Struct({
  id: SharingId,
  name: title,
  token: SharingToken,
});

export function sharingEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      (url.protocol === "http:" && url.hostname === "127.0.0.1") ||
      (url.protocol === "https:" && /^[a-z0-9.-]+\.ts\.net$/.test(url.hostname))
    )
  )
    throw new Error("Use the local or private Tailscale endpoint printed by the sharing service.");
  return url.origin;
}

export function sharingPairUrl(endpoint: string, token: string): string {
  return `irudd-scope://pair-sharing?endpoint=${encodeURIComponent(sharingEndpoint(endpoint))}#${decode(SharingToken, token)}`;
}

export function readSharingPairUrl(value: string) {
  try {
    if (value.length > 4096) throw new Error();
    const url = new URL(value.trim());
    if (
      url.protocol !== "irudd-scope:" ||
      url.hostname !== "pair-sharing" ||
      url.username ||
      url.password
    )
      throw new Error();
    return {
      endpoint: sharingEndpoint(url.searchParams.get("endpoint") ?? ""),
      token: decode(SharingToken, url.hash.slice(1)),
    };
  } catch {
    throw new Error("Paste the complete URL printed by irudd-scope sharing pair.");
  }
}

export async function sharingJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("The sharing service returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) throw new Error("The sharing service returned an oversized response.");
      text += decoder.decode(item.value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    if (!response.ok)
      throw new SharingRequestError(
        response.status,
        typeof value.error === "string" ? value.error : "The sharing service refused the request.",
      );
    return value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class SharingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
