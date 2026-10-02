import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import {
  TransferInvitation,
  TransferSecret,
  MAX_TRANSFER_FRAME_BYTES,
} from "@irudd-scope/protocol/transfer";

const Envelope = Schema.Struct({
  nonce: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16}$/)),
  tag: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  data: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-]*$/),
    Schema.isMaxLength(MAX_TRANSFER_FRAME_BYTES),
  ),
});

function descriptor(invitation: Omit<TransferInvitation, "mac">) {
  return JSON.stringify([
    invitation.version,
    invitation.mode,
    invitation.id,
    invitation.pairId,
    invitation.sourceId,
    invitation.issuedAt,
    invitation.expiresAt,
    invitation.address,
  ]);
}

export function signInvitation(
  invitation: Omit<TransferInvitation, "mac">,
  secret: string,
): TransferInvitation {
  decode(TransferSecret, secret);
  return decode(TransferInvitation, {
    ...invitation,
    mac: createHmac("sha256", Buffer.from(secret, "base64url"))
      .update(descriptor(invitation))
      .digest("base64url"),
  });
}

export function verifyInvitation(invitation: TransferInvitation, secret: string): void {
  const actual = Buffer.from(invitation.mac, "base64url");
  const expected = Buffer.from(signInvitation(invitation, secret).mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("This link does not match the paired Scope or pairing secret.");
}

function key(secret: string, invitation: TransferInvitation, direction: "request" | "response") {
  decode(TransferSecret, secret);
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "base64url"),
      invitation.id,
      `scope-transfer-v1-${direction}`,
      32,
    ),
  );
}

export function encryptTransfer(
  secret: string,
  invitation: TransferInvitation,
  direction: "request" | "response",
  value: unknown,
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret, invitation, direction), nonce);
  cipher.setAAD(Buffer.from(descriptor(invitation)));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  });
}

export function decryptTransfer(
  secret: string,
  invitation: TransferInvitation,
  direction: "request" | "response",
  body: string,
): { nonce: string; value: unknown } {
  if (Buffer.byteLength(body) > MAX_TRANSFER_FRAME_BYTES)
    throw new Error("Transfer message exceeds its limit.");
  const envelope = decode(Envelope, JSON.parse(body));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(secret, invitation, direction),
    Buffer.from(envelope.nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(descriptor(invitation)));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const bytes = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")),
    decipher.final(),
  ]);
  return { nonce: envelope.nonce, value: JSON.parse(bytes.toString("utf8")) };
}
