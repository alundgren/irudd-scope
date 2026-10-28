import { parse } from "smol-toml";
import { MAX_HARNESS_MCP_SERVERS, type HarnessMcpServer } from "@irudd-scope/protocol/harnesses";
import { compareNames, isRecord } from "./files.ts";

type Transport = HarnessMcpServer["transport"];

/**
 * Reads only an MCP server's name and transport. Commands, arguments, URLs, headers and
 * environment values stay in the parsed object and are never copied out.
 */
export function mcpServers(table: unknown): HarnessMcpServer[] {
  if (!isRecord(table)) return [];
  return Object.entries(table)
    .filter(([name]) => name.length > 0 && name.length <= 255)
    .map(([name, server]) => ({ name, transport: transport(server), location: "own" as const }))
    .sort((left, right) => compareNames(left.name, right.name))
    .slice(0, MAX_HARNESS_MCP_SERVERS);
}

function transport(server: unknown): Transport {
  if (!isRecord(server)) return "unknown";
  const type = typeof server.type === "string" ? server.type.toLowerCase() : "";
  if (type === "stdio") return "stdio";
  if (type === "sse") return "sse";
  if (["http", "streamable-http", "streamable_http", "streamablehttp"].includes(type))
    return "http";
  if (type) return "unknown";
  if (typeof server.command === "string") return "stdio";
  if (typeof server.url === "string") return "http";
  return "unknown";
}

/** Parses TOML without letting a parse error escape; its message quotes the input. */
export function parseTomlObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
