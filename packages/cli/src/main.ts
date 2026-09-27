#!/usr/bin/env node
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ArtifactId,
  ArtifactKind,
  DEFAULT_CONNECTION_FILE,
  DEFAULT_PORT,
  MAX_CONTENT_BYTES,
  Source,
  decode,
  decodeLocalConnection,
} from "@irudd-scope/protocol";
import { MAX_MAINTENANCE_TIMEOUT_MS } from "@irudd-scope/protocol/maintenance";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { setup, manageHub, installSkill, printPairing } from "./setup.ts";

const help = `irudd-scope add FILE [--title TITLE] [--id ID]
irudd-scope text TEXT [--title TITLE] [--id ID] [--kind text|markdown]
irudd-scope update ID FILE [--title TITLE]
irudd-scope list
irudd-scope get ID
irudd-scope delete ID
irudd-scope shrink [--status]
irudd-scope setup [--yes] [--https-port PORT] [--port PORT] [--no-pair]
irudd-scope pair
irudd-scope hub start|stop|status|unpair|remove
irudd-scope hub shrink [--status]
irudd-scope skill install|remove

Options: --endpoint URL, --token-file PATH, --agent NAME, --session-id ID, --timeout-ms MS
The command timeout defaults to 10000 ms. Use --timeout-ms 120000 for shrinking or slow uploads.
Open Scope on this Mac to publish locally without connection setup.
Environment: SCOPE_CONNECTION_FILE, or SCOPE_ENDPOINT with SCOPE_TOKEN_FILE or SCOPE_TOKEN
Output is JSON. Updates read the current revision and reject concurrent changes.
Unavailable desktops return an error. Requests are not queued or replayed.
`;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PROVENANCE_TIMEOUT_MS = 250;
const exec = promisify(execFile);

async function git(args: string[], deadline: number): Promise<string | undefined> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return undefined;
  const timeout = Math.ceil(remaining);
  try {
    const { stdout } = await exec("git", args, {
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function provenance(
  agent: string | undefined,
  sessionId: string | undefined,
  commandDeadline: number,
): Promise<Source> {
  const deadline = Math.min(commandDeadline, performance.now() + PROVENANCE_TIMEOUT_MS);
  const [directories, branch] = await Promise.all([
    git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], deadline),
    git(["branch", "--show-current"], deadline),
  ]);
  const [commonDirectory, worktree] = directories?.split("\n") ?? [];
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

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
    throw new Error(`--timeout-ms must be a whole number from 1 to ${MAX_TIMEOUT_MS}.`);
  return timeout;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      title: { type: "string" },
      id: { type: "string" },
      kind: { type: "string" },
      endpoint: { type: "string" },
      "token-file": { type: "string" },
      agent: { type: "string" },
      "session-id": { type: "string" },
      "timeout-ms": { type: "string" },
      yes: { type: "boolean" },
      "https-port": { type: "string" },
      port: { type: "string" },
      "no-pair": { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command, argument, replacement] = positionals;
  if (command === "setup") {
    await setup({
      yes: values.yes,
      httpsPort: values["https-port"],
      port: values.port,
      noPair: values["no-pair"],
    });
    return;
  }
  if (command === "pair") {
    await printPairing();
    return;
  }
  if (command === "hub") {
    await manageHub(argument, parseTimeout(values["timeout-ms"]), values.status);
    return;
  }
  if (command === "skill") {
    if (argument !== "install" && argument !== "remove")
      throw new Error("Use irudd-scope skill install or remove.");
    await installSkill(argument === "remove");
    return;
  }
  if (!["add", "text", "update", "list", "get", "delete", "shrink"].includes(command))
    throw new Error(`Unknown command.\n${help}`);
  const timeoutMs = parseTimeout(values["timeout-ms"]);
  if (!["list", "shrink"].includes(command) && !argument)
    throw new Error("This command needs a file, text, or artifact ID. Use --help.");
  if (command === "update" && !replacement)
    throw new Error("Update needs an artifact ID and a replacement file.");
  if ((command === "get" || command === "update" || command === "delete") && argument)
    decode(ArtifactId, argument);
  if ((command === "add" || command === "text") && values.id) decode(ArtifactId, values.id);
  if (command === "text" && values.kind && !["text", "markdown"].includes(values.kind))
    throw new Error("Text accepts --kind text or markdown.");

  const signal = AbortSignal.timeout(timeoutMs);
  const commandDeadline = performance.now() + timeoutMs;
  let publicationId: string | undefined;
  try {
    const tokenFile = values["token-file"] ?? process.env.SCOPE_TOKEN_FILE;
    let endpoint = values.endpoint ?? process.env.SCOPE_ENDPOINT;
    let token = process.env.SCOPE_TOKEN;
    if (endpoint !== undefined || tokenFile !== undefined || token !== undefined) {
      if (tokenFile !== undefined)
        token = (await readFile(tokenFile, { encoding: "utf8", signal })).trim();
      if (!token)
        throw new Error(
          "An explicit endpoint needs --token-file, SCOPE_TOKEN_FILE, or SCOPE_TOKEN.",
        );
      endpoint ??= `http://127.0.0.1:${DEFAULT_PORT}`;
    } else {
      const connectionFile =
        process.env.SCOPE_CONNECTION_FILE ?? join(homedir(), DEFAULT_CONNECTION_FILE);
      try {
        ({ endpoint, token } = decodeLocalConnection(
          JSON.parse(await readFile(connectionFile, { encoding: "utf8", signal })),
        ));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new Error("Open Scope on this Mac before publishing. Requests are not queued.");
        throw new Error(
          "Cannot read the local Scope connection file. Check its path and permissions.",
        );
      }
    }
    const client = new ScopeClient(endpoint, token, { signal });
    if (command === "delete") {
      console.log(JSON.stringify(await client.delete(argument!), null, 2));
      return;
    }
    if (command === "shrink") {
      const receipt = values.status
        ? await client.maintenanceStatus()
        : await client.shrink(
            Math.max(
              1,
              Math.min(MAX_MAINTENANCE_TIMEOUT_MS, Math.floor(commandDeadline - performance.now())),
            ),
          );
      console.log(JSON.stringify(receipt, null, 2));
      if (!values.status && receipt.databases.some((database) => database.status !== "completed"))
        process.exitCode = 1;
      return;
    }
    if (command === "list") {
      console.log(JSON.stringify(await client.list(), null, 2));
      return;
    }
    if (command === "get") {
      console.log(JSON.stringify(await client.get(argument!), null, 2));
      return;
    }

    let file: string | undefined;
    let kind: ArtifactKind;
    let mediaType: string;
    let fileName: string;
    if (command === "text") {
      kind = values.kind === "markdown" ? "markdown" : "text";
      mediaType = kind === "markdown" ? "text/markdown" : "text/plain";
      fileName = kind === "markdown" ? "note.md" : "note.txt";
    } else {
      file = command === "update" ? replacement! : argument!;
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_CONTENT_BYTES)
        throw new Error("Choose a file no larger than 32 MiB.");
      ({ kind, mediaType } = detect(file));
      fileName = basename(file);
    }

    const [current, source, content] = await Promise.all([
      command === "update" ? client.get(argument!) : Promise.resolve(undefined),
      provenance(values.agent, values["session-id"], commandDeadline),
      file ? readFile(file, { signal }) : Promise.resolve(new TextEncoder().encode(argument!)),
    ]);
    const id = current?.id ?? values.id ?? randomUUID();
    publicationId = id;
    const artifact = await client.publish(
      id,
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
  } catch (error) {
    if (!signal.aborted) throw error;
    const outcome = publicationId
      ? ` Artifact ${publicationId} may have been published; read it before retrying.`
      : "";
    throw new Error(`Scope command timed out after ${timeoutMs} ms.${outcome}`, { cause: error });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Scope command failed."}\n`);
  process.exitCode = 1;
});
