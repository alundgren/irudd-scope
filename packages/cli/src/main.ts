#!/usr/bin/env node
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ArtifactKind,
  DEFAULT_CONNECTION_FILE,
  DEFAULT_PORT,
  MAX_CONTENT_BYTES,
  Source,
  decode,
  decodeLocalConnection,
} from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";

const help = `irudd-scope add FILE [--title TITLE] [--id ID]
irudd-scope text TEXT [--title TITLE] [--id ID] [--kind text|markdown]
irudd-scope update ID FILE [--title TITLE]
irudd-scope list
irudd-scope get ID

Options: --endpoint URL, --token-file PATH, --agent NAME, --session-id ID
Open Scope on this Mac to publish locally without connection setup.
Environment: SCOPE_CONNECTION_FILE, or SCOPE_ENDPOINT with SCOPE_TOKEN_FILE or SCOPE_TOKEN
Output is JSON. Updates read the current revision and reject concurrent changes.
Unavailable desktops return an error. Requests are not queued or replayed.
`;

const exec = promisify(execFile);
async function provenance(agent?: string, sessionId?: string): Promise<Source> {
  const git = async (...args: string[]) => {
    try {
      return (
        (await exec("git", args, { timeout: 1500, maxBuffer: 4096 })).stdout.trim() || undefined
      );
    } catch {
      return undefined;
    }
  };
  const [commonDirectory, branch, worktree] = await Promise.all([
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    git("branch", "--show-current"),
    git("rev-parse", "--show-toplevel"),
  ]);
  const repo =
    commonDirectory && basename(commonDirectory) === ".git"
      ? dirname(commonDirectory)
      : commonDirectory;
  return decode(
    Source,
    Object.fromEntries(
      Object.entries({
        host: hostname(),
        cwd: process.cwd(),
        repo,
        branch,
        worktree,
        agent,
        sessionId,
      }).filter(([, value]) => value !== undefined && value.length <= 512),
    ),
  );
}

function detect(file: string): { kind: ArtifactKind; mediaType: string } {
  const types: Record<string, [ArtifactKind, string]> = {
    ".txt": ["text", "text/plain"],
    ".md": ["markdown", "text/markdown"],
    ".markdown": ["markdown", "text/markdown"],
    ".html": ["html", "text/html"],
    ".htm": ["html", "text/html"],
    ".png": ["image", "image/png"],
    ".jpg": ["image", "image/jpeg"],
    ".jpeg": ["image", "image/jpeg"],
    ".gif": ["image", "image/gif"],
    ".webp": ["image", "image/webp"],
    ".avif": ["image", "image/avif"],
    ".excalidraw": ["excalidraw", "application/vnd.excalidraw+json"],
  };
  const [kind, mediaType] = types[extname(file).toLowerCase()] ?? [
    "file",
    "application/octet-stream",
  ];
  return { kind, mediaType };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      title: { type: "string" },
      id: { type: "string" },
      kind: { type: "string" },
      endpoint: { type: "string" },
      "token-file": { type: "string" },
      agent: { type: "string" },
      "session-id": { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command, argument, replacement] = positionals;
  if (!["add", "text", "update", "list", "get"].includes(command))
    throw new Error(`Unknown command.\n${help}`);
  const tokenFile = values["token-file"] ?? process.env.SCOPE_TOKEN_FILE;
  let endpoint = values.endpoint ?? process.env.SCOPE_ENDPOINT;
  let token = process.env.SCOPE_TOKEN;
  if (endpoint !== undefined || tokenFile !== undefined || token !== undefined) {
    if (tokenFile !== undefined) token = (await readFile(tokenFile, "utf8")).trim();
    if (!token)
      throw new Error("An explicit endpoint needs --token-file, SCOPE_TOKEN_FILE, or SCOPE_TOKEN.");
    endpoint ??= `http://127.0.0.1:${DEFAULT_PORT}`;
  } else {
    const file = process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE);
    try {
      ({ endpoint, token } = decodeLocalConnection(JSON.parse(await readFile(file, "utf8"))));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new Error("Open Scope on this Mac before publishing. Requests are not queued.");
      throw new Error(
        "Cannot read the local Scope connection file. Check its path and permissions.",
      );
    }
  }
  const client = new ScopeClient(endpoint, token);
  if (command === "list") {
    console.log(JSON.stringify(await client.list(), null, 2));
    return;
  }
  if (!argument) throw new Error("This command needs a file, text, or artifact ID. Use --help.");
  if (command === "get") {
    console.log(JSON.stringify(await client.get(argument), null, 2));
    return;
  }
  const current = command === "update" ? await client.get(argument) : undefined;
  const source = await provenance(values.agent, values["session-id"]);
  let content: Uint8Array;
  let kind: ArtifactKind;
  let mediaType: string;
  let fileName: string;
  if (command === "text") {
    if (values.kind && !["text", "markdown"].includes(values.kind))
      throw new Error("Text accepts --kind text or markdown.");
    kind = values.kind === "markdown" ? "markdown" : "text";
    mediaType = kind === "markdown" ? "text/markdown" : "text/plain";
    fileName = kind === "markdown" ? "note.md" : "note.txt";
    content = new TextEncoder().encode(argument);
  } else {
    const file = current ? replacement : argument;
    if (!file) throw new Error("Update needs an artifact ID and a replacement file.");
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CONTENT_BYTES)
      throw new Error("Choose a file no larger than 32 MiB.");
    content = await readFile(file);
    ({ kind, mediaType } = detect(file));
    fileName = basename(file);
  }
  const artifact = await client.publish(
    current?.id ?? values.id ?? randomUUID(),
    {
      title: values.title ?? current?.title ?? (command === "text" ? "Note" : fileName),
      kind,
      mediaType,
      fileName,
      source,
      expectedRevision: current?.revision ?? 0,
    },
    content,
  );
  console.log(JSON.stringify(artifact, null, 2));
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Scope command failed."}\n`);
  process.exitCode = 1;
});
