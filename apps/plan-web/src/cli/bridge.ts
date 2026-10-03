import {
  McpServer,
  fromJsonSchema,
  type Tool,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { mcpRequest, callTool } from "./client.ts";
import type { SavedCredential } from "./credentials.ts";

export async function bridge(credential: SavedCredential) {
  const listed = (await mcpRequest(credential, "tools/list")) as { tools: Tool[] };
  serveStdio(
    () => {
      const server = new McpServer({ name: "plan-web-cli", version: "0.1.0" });
      for (const tool of listed.tools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
          },
          (args) => callTool(credential, tool.name, args),
        );
      }
      return server;
    },
    { onerror: () => process.stderr.write("MCP connection error.\n") },
  );
}
