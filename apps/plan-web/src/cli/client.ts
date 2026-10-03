import type { CallToolResult } from "@modelcontextprotocol/server";
import type { SavedCredential } from "./credentials.ts";

export const protocolVersion = "2026-07-28";
export function endpoint(value: string) {
  const uri = new URL(value);
  if (
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    !(
      uri.protocol === "https:" ||
      (uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname))
    )
  )
    throw new Error("Server must use HTTPS or loopback HTTP.");
  if (uri.pathname !== "/" && uri.pathname !== "/mcp")
    throw new Error("Use the server origin or its /mcp endpoint.");
  return `${uri.origin}/mcp`;
}
export async function mcpRequest(
  credential: SavedCredential,
  method: string,
  params: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${credential.token}`,
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Method": method,
  };
  if (method === "tools/call") headers["Mcp-Name"] = String(params.name);
  const response = await fetch(credential.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": { name: "plan-web-cli", version: "0.1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 401)
    throw new Error("Authorization expired or revoked. Run plan-web login again.");
  const value = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (!response.ok || value.error)
    throw new Error(
      value.error?.message ??
        `MCP request failed with HTTP ${response.status}. Keep the same mutation requestId if the outcome is uncertain.`,
    );
  return value.result;
}
export async function callTool(credential: SavedCredential, name: string, args: unknown) {
  return (await mcpRequest(credential, "tools/call", { name, arguments: args })) as CallToolResult;
}
