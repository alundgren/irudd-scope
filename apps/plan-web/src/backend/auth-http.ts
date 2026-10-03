import type { IncomingMessage, ServerResponse } from "node:http";
export function authJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
export async function authBody(request: IncomingMessage) {
  const buffers: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 16_384) throw new Error("Authorization body exceeds 16 KiB.");
    buffers.push(bytes);
  }
  return Buffer.concat(buffers).toString("utf8");
}
export function authText(value: unknown, maximum = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || !value.isWellFormed())
    throw new Error("Invalid authorization input.");
  return value;
}
export function validRedirect(value: string) {
  const uri = new URL(value);
  if (
    uri.hash ||
    uri.username ||
    uri.password ||
    !(
      uri.protocol === "https:" ||
      (uri.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname))
    )
  )
    throw new Error("Redirect must use HTTPS or loopback HTTP.");
  return value;
}
export function approvalCookie(request: IncomingMessage) {
  return /(?:^|;\s*)plan_approval=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? "")?.[1];
}
