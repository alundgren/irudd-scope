import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

export const guestSecret = () => randomBytes(32).toString("base64url");
export function signGuest(key: string, purpose: string, value: unknown) {
  return createHmac("sha256", Buffer.from(key, "base64url"))
    .update("scope-guest:" + purpose + ":" + JSON.stringify(value))
    .digest("base64url");
}
export function verifyGuest(key: string, purpose: string, value: unknown, mac: string) {
  const expected = Buffer.from(signGuest(key, purpose, value));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("The guest connection could not be authenticated.");
}
export async function guestJson(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 16384) throw new Error("Guest message is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export function guestReply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify(value));
}
