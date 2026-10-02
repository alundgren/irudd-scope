import { Schema } from "effect";
import { Artifact, BlobId, MAX_CONTENT_BYTES, decode, validateArtifactContent } from "./index.ts";

export const TRANSFER_LIFETIME_MS = 15 * 60_000;
export const MAX_TRANSFER_FRAME_BYTES = 64 * 1024 * 1024;
export const TransferId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export const TransferSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const TailcatAddress = Schema.String.check(
  Schema.isPattern(/^tc[A-Za-z0-9_-]+$/),
  Schema.isMinLength(40),
  Schema.isMaxLength(4096),
);
export const TransferName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
export const TransferInvitation = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literals(["pair", "tab"]),
  id: TransferId,
  pairId: TransferId,
  sourceId: TransferId,
  issuedAt: Schema.Int.check(Schema.isGreaterThan(0)),
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  address: TailcatAddress,
  mac: TransferSecret,
});
export type TransferInvitation = typeof TransferInvitation.Type;

export const TRANSFER_KINDS = ["text", "markdown", "html", "image", "file", "excalidraw"] as const;
export function isTransferKind(value: string): value is (typeof TRANSFER_KINDS)[number] {
  return TRANSFER_KINDS.some((kind) => kind === value);
}
export const TransferManifest = Schema.Struct({
  version: Schema.Literal(1),
  title: TransferName,
  kind: Schema.Literals(TRANSFER_KINDS),
  fileName: Artifact.fields.fileName,
  mediaType: Artifact.fields.mediaType,
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_CONTENT_BYTES })),
  blob: BlobId,
});
export type TransferManifest = typeof TransferManifest.Type;

export function decodeTransferManifest(value: unknown): TransferManifest {
  const manifest = decode(TransferManifest, value);
  validateArtifactContent(manifest);
  return manifest;
}

export function transferUrl(invitation: TransferInvitation): string {
  const bytes = new TextEncoder().encode(JSON.stringify(decode(TransferInvitation, invitation)));
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `scope-transfer://v1/#${encoded}`;
}

export function readTransferUrl(value: string): TransferInvitation {
  if (value.length > 8192) throw new Error("This Scope transfer link is too long.");
  try {
    const url = new URL(value.trim());
    if (url.href !== `scope-transfer://v1/${url.hash}` || !/^#[A-Za-z0-9_-]+$/.test(url.hash))
      throw new Error("Invalid link.");
    const binary = atob(url.hash.slice(1).replaceAll("-", "+").replaceAll("_", "/"));
    const invitation = decode(
      TransferInvitation,
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(binary, (character) => character.charCodeAt(0)),
        ),
      ),
    );
    if (invitation.expiresAt - invitation.issuedAt !== TRANSFER_LIFETIME_MS)
      throw new Error("Invalid lifetime.");
    return invitation;
  } catch {
    throw new Error("Paste a valid Scope transfer link.");
  }
}
