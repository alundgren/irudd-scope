#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { endpoint, callTool, mcpRequest } from "./client.ts";
import { credentialStore } from "./credentials.ts";
import { login } from "./login.ts";
import { bridge } from "./bridge.ts";

const args = process.argv.slice(2);
const command = args[0];
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}.`);
  return args[index + 1];
}
function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
async function run() {
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(
      `plan-web login [--server URL] [--agent NAME] [--no-browser]\nplan-web whoami [--server URL]\nplan-web logout [--server URL]\nplan-web tools [--server URL]\nplan-web call TOOL --json JSON_OR_@FILE [--server URL]\nplan-web mcp [--server URL]\nplan-web mcp-config [--server URL]\n\nDefaults to http://127.0.0.1:43130. Login approves Alex, Blair or Casey in the browser.\n`,
    );
    return;
  }
  const url = endpoint(option("--server", "http://127.0.0.1:43130"));
  if (command === "mcp-config") {
    output({
      mcpServers: {
        "plan-web": { command: process.execPath, args: [process.argv[1], "mcp", "--server", url] },
      },
    });
    return;
  }
  const credentials = credentialStore();
  try {
    if (command === "login") {
      const value = await login(
        url,
        option("--agent", "Coding agent"),
        args.includes("--no-browser"),
      );
      try {
        credentials.save(value);
      } catch (error) {
        await revoke(value.endpoint, value.token);
        throw error;
      }
      process.stdout.write("Agent approved. Run plan-web whoami or plan-web mcp-config.\n");
      return;
    }
    const credential = credentials.get(url, command === "logout");
    if (command === "whoami") {
      const response = await fetch(`${new URL(url).origin}/auth/whoami`, {
        headers: { Authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Authorization expired or revoked. Run login again.");
      output(await response.json());
      return;
    }
    if (command === "logout") {
      await revoke(url, credential.token);
      credentials.remove(url);
      process.stdout.write("Agent credential revoked.\n");
      return;
    }
    if (command === "tools") {
      output(await mcpRequest(credential, "tools/list"));
      return;
    }
    if (command === "call") {
      const value = option("--json", "{}");
      const input = JSON.parse(
        value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value,
      ) as unknown;
      const result = await callTool(credential, args[1], input);
      output(result);
      if (result.isError) process.exitCode = 1;
      return;
    }
    if (command === "mcp") {
      await bridge(credential);
      return;
    }
    throw new Error("Unknown command. Run plan-web --help.");
  } finally {
    credentials.close();
  }
}
async function revoke(endpoint: string, token: string) {
  const response = await fetch(`${new URL(endpoint).origin}/auth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error("Revocation failed. Retry logout when the server is available.");
}
run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Command failed."}\n`);
  process.exitCode = 1;
});
