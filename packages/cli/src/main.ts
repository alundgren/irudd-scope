#!/usr/bin/env node
import { RetroGuide, retroCommand } from "./retro.ts";
import { LibrarianGuide } from "@irudd-scope/protocol/librarian";
import { librarianCommand } from "./librarian.ts";
import { MemoryGuide } from "@irudd-scope/protocol/memory";
import { watchRetro } from "./retro-watch.ts";
import { PullRequestsGuide, pullRequestsCommand } from "./pull-requests.ts";
import { VoiceGuide } from "@irudd-scope/protocol/voice";
import { voiceCommand, voiceHelp } from "./voice.ts";
import { Schema } from "effect";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ArtifactId,
  ArtifactName,
  ArtifactKind,
  defaultConnectionFile,
  DEFAULT_PORT,
  MAX_CONTENT_BYTES,
  Source,
  ScopeError,
  decode,
  decodeLocalConnection,
} from "@irudd-scope/protocol";
import { MAX_MAINTENANCE_TIMEOUT_MS } from "@irudd-scope/protocol/maintenance";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { setup, manageHub, printPairing } from "./setup.ts";
import { checkSkill, installSkill, syncSkill } from "./skill.ts";
import { PlanGuide, planCommand } from "./plan.ts";
import { watchPlan } from "./plan-watch.ts";
import {
  decodeTransferImportRequest,
  TRANSFER_IMPORT_TIMEOUT_MS,
} from "@irudd-scope/protocol/transfer";

const help = `irudd-scope add FILE [--title TITLE] [--id ID] [--named | --name NAME] [--plan | --pull-requests | --retro]
irudd-scope text TEXT [--title TITLE] [--id ID] [--kind text|markdown]
irudd-scope update ID_OR_NAME FILE [--title TITLE]
irudd-scope import-link LINK [--timeout-ms MS]
irudd-scope pull-requests guide|read|configure|sync|detail|apply [NAME_OR_FILE] [OWNER/REPO_OR_NODE_ID]
irudd-scope retro guide|settings|read NAME|apply REQUEST.json|history|watch NAME
irudd-scope memory guide|status|connect OWNER/REPO
irudd-scope librarian guide|read|apply REQUEST.json
irudd-scope plan guide
irudd-scope plan read NAME [--since VERSION]
irudd-scope plan feedback NAME [ROUND_ID] --output NEW_DIRECTORY
irudd-scope plan content NAME [--revision N] --output NEW_FILE.html
irudd-scope plan image NAME HASH --output NEW_FILE.png
irudd-scope plan respond|apply REQUEST.json
irudd-scope plan watch NAME [--claude-channel | --t3-thread ID | --codex-thread ID]
irudd-scope voice generate|status|result|cancel|guide [FILE_OR_ID]
irudd-scope list
irudd-scope get ID
irudd-scope delete ID
irudd-scope shrink [--status]
irudd-scope setup [--yes] [--https-port PORT] [--port PORT] [--no-pair]
irudd-scope pair
irudd-scope hub start|stop|status|unpair|remove|queue
irudd-scope hub discard ID
irudd-scope hub shrink [--status]
irudd-scope skill install|remove|check|sync

Options: --endpoint URL, --token-file PATH, --agent NAME, --session-id ID, --timeout-ms MS
The command timeout defaults to 10000 ms. Use --timeout-ms 120000 for shrinking or slow uploads.
Open Scope on this computer to publish locally without connection setup.
Environment: SCOPE_CONNECTION_FILE, or SCOPE_ENDPOINT with SCOPE_TOKEN_FILE or SCOPE_TOKEN
Output is JSON. Updates read the current revision and reject concurrent changes.
Offline updates use the paired hub's saved revision and block on delivery if the tab changed.
Paired hubs store publications before delivery, up to 50 tabs for 48 hours.
Queued publications return an expiry receipt. Use hub queue to inspect them or hub discard ID to cancel.
Import-link imports a tab sharing link into the receiver's paired Scope without a desktop confirmation.
Create sharing links and pair in the desktop app. Both computers must be online with Tailcat installed separately.
Import-link defaults to a 300000 ms timeout and is never queued. Retry the same link after an uncertain result.
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
      windowsHide: true,
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

function parseOptions() {
  return parseArgs({
    allowPositionals: true,
    options: {
      named: { type: "boolean" },
      plan: { type: "boolean" },
      retro: { type: "boolean" },
      "pull-requests": { type: "boolean" },
      revision: { type: "string" },
      since: { type: "string" },
      name: { type: "string" },
      "claude-channel": { type: "boolean" },
      "t3-thread": { type: "string" },
      "t3-endpoint": { type: "string" },
      "t3-token-file": { type: "string" },
      "codex-thread": { type: "string" },
      "codex-url": { type: "string" },
      output: { type: "string" },
      receipt: { type: "string" },
      "request-id": { type: "string" },
      instructions: { type: "string" },
      voice: { type: "string" },
      "refresh-billing": { type: "boolean" },
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
}

type Options = ReturnType<typeof parseOptions>["values"];

function artifactName(values: Options, title: string) {
  if (values.named && values.name) throw new Error("Choose --named or --name, not both.");
  if (values.name) return decode(ArtifactName, values.name);
  if (!values.named) return undefined;
  const prefix =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 110)
      .replace(/-+$/g, "") || "artifact";
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function validateArtifactCommand(
  command: string,
  argument: string | undefined,
  replacement: string | undefined,
  values: Options,
) {
  if (!["add", "text", "update", "list", "get", "delete", "shrink"].includes(command))
    throw new Error(`Unknown command.\n${help}`);
  const timeoutMs = parseTimeout(values["timeout-ms"]);
  if (!["list", "shrink"].includes(command) && !argument)
    throw new Error("This command needs a file, text, or artifact ID. Use --help.");
  if (command === "update" && !replacement)
    throw new Error("Update needs an artifact ID and a replacement file.");
  if (["get", "update", "delete"].includes(command)) decode(ArtifactId, argument);
  if (["add", "text"].includes(command) && values.id) decode(ArtifactId, values.id);
  if (command === "text" && values.kind && !["text", "markdown"].includes(values.kind))
    throw new Error("Text accepts --kind text or markdown.");
  return timeoutMs;
}

async function connect(values: Options, signal: AbortSignal) {
  const tokenFile = values["token-file"] ?? process.env.SCOPE_TOKEN_FILE;
  let endpoint = values.endpoint ?? process.env.SCOPE_ENDPOINT;
  let token = process.env.SCOPE_TOKEN;
  if (endpoint !== undefined || tokenFile !== undefined || token !== undefined) {
    if (tokenFile !== undefined)
      token = (await readFile(tokenFile, { encoding: "utf8", signal })).trim();
    if (!token)
      throw new Error("An explicit endpoint needs --token-file, SCOPE_TOKEN_FILE, or SCOPE_TOKEN.");
    endpoint ??= `http://127.0.0.1:${DEFAULT_PORT}`;
  } else {
    ({ endpoint, token } = await localConnection(signal));
  }
  return new ScopeClient(endpoint, token, { signal });
}

async function localConnection(signal: AbortSignal) {
  const connectionFile =
    process.env.SCOPE_CONNECTION_FILE ??
    defaultConnectionFile(process.platform, homedir(), process.env.LOCALAPPDATA);
  try {
    return decodeLocalConnection(
      JSON.parse(await readFile(connectionFile, { encoding: "utf8", signal })),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error("Open Scope on this computer before publishing. Requests are not queued.");
    throw new Error("Cannot read the local Scope connection file. Check its path and permissions.");
  }
}

async function resolveArtifact(client: ScopeClient, key: string) {
  try {
    return await client.get(key);
  } catch (error) {
    if (!(error instanceof ScopeError) || error.status !== 404) throw error;
    try {
      decode(ArtifactName, key);
    } catch {
      throw error;
    }
    try {
      return await client.named(key);
    } catch (namedError) {
      if (namedError instanceof ScopeError && namedError.status === 404) throw error;
      throw namedError;
    }
  }
}

async function publicationContent(
  command: string,
  argument: string,
  replacement: string | undefined,
  kindOption: string | undefined,
) {
  let file: string | undefined;
  let kind: ArtifactKind;
  let mediaType: string;
  let fileName: string;
  if (command === "text") {
    kind = kindOption === "markdown" ? "markdown" : "text";
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

  return { file, kind, mediaType, fileName };
}

async function preparePublication(
  client: ScopeClient,
  positionals: string[],
  values: Options,
  signal: AbortSignal,
  deadline: number,
) {
  const [command, argument, replacement] = positionals;
  const { file, kind, mediaType, fileName } = await publicationContent(
    command,
    argument!,
    replacement,
    values.kind,
  );

  const [current, source, content] = await Promise.all([
    command === "update" ? client.updateBase(argument!) : Promise.resolve(undefined),
    provenance(values.agent, values["session-id"], deadline),
    file ? readFile(file, { signal }) : Promise.resolve(new TextEncoder().encode(argument!)),
  ]);
  const id = current?.id ?? values.id ?? randomUUID();
  const title = values.title ?? current?.title ?? (command === "text" ? "Note" : fileName);
  if (values.plan && command !== "add") throw new Error("Use --plan when adding an HTML file.");
  if (values["pull-requests"] && command !== "add")
    throw new Error("Use --pull-requests when adding an HTML file.");
  if (values.retro && command !== "add") throw new Error("Use --retro when adding an HTML file.");
  if ([values.plan, values["pull-requests"], values.retro].filter(Boolean).length > 1)
    throw new Error("Choose one tab kind.");
  const isRetro = values.retro || current?.kind === "retro";
  if (isRetro && mediaType !== "text/html") throw new Error("Retrospectives require an HTML file.");
  const isPullRequests = values["pull-requests"] || current?.kind === "pull-requests";
  const isPlan = values.plan || current?.kind === "plan";
  if (isPullRequests && mediaType !== "text/html")
    throw new Error("Pull request tabs require an HTML file.");
  if (isPullRequests && !current?.name && !values.name && !values.named)
    throw new Error("Pull request tabs require --name NAME or --named.");
  if (isPlan && mediaType !== "text/html") throw new Error("Plans require an HTML file.");
  const name =
    current?.name ??
    artifactName((isPlan || isRetro) && !values.name ? { ...values, named: true } : values, title);
  return {
    id,
    input: {
      title,
      ...(name ? { name } : {}),
      kind: isRetro ? "retro" : isPullRequests ? "pull-requests" : isPlan ? "plan" : kind,
      mediaType,
      fileName,
      source,
      expectedRevision: current?.revision ?? 0,
    },
    content,
  };
}

async function main() {
  const { values, positionals } = parseOptions();
  if (values.help || !positionals.length) {
    process.stdout.write(positionals[0] === "voice" ? voiceHelp : help);
    return;
  }
  const [command, argument, replacement] = positionals;
  if (command === "import-link") {
    if (!argument || positionals.length !== 2) throw new Error("Use irudd-scope import-link LINK.");
    const input = decodeTransferImportRequest({ url: argument });
    const signal = AbortSignal.timeout(
      parseTimeout(values["timeout-ms"] ?? String(TRANSFER_IMPORT_TIMEOUT_MS)),
    );
    const client = await connect(values, signal);
    try {
      console.log(JSON.stringify(await client.importLink(input.url), null, 2));
    } catch (error) {
      if (signal.aborted)
        throw new Error(
          "Link import timed out. The copy may already be saved; retry the same link to check it.",
        );
      if (error instanceof ScopeError && error.status === 404)
        throw new Error(
          "Link import is unavailable. Update and open Scope on the receiver and update its hub if used.",
        );
      throw error;
    }
    return;
  }
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
    if (argument === "queue" || argument === "discard") {
      if (argument === "discard" && !replacement)
        throw new Error("Provide the buffered artifact ID to discard.");
      const client = await connect(values, AbortSignal.timeout(parseTimeout(values["timeout-ms"])));
      console.log(
        JSON.stringify(
          argument === "queue"
            ? await client.hubQueue()
            : await client.discardQueuedPublication(replacement!),
          null,
          2,
        ),
      );
      return;
    }
    await manageHub(argument, parseTimeout(values["timeout-ms"]), values.status);
    return;
  }
  if (command === "skill") {
    if (argument === "check" || argument === "sync") {
      console.log(
        JSON.stringify({ installed: await (argument === "check" ? checkSkill() : syncSkill()) }),
      );
      return;
    }
    if (argument !== "install" && argument !== "remove")
      throw new Error("Use irudd-scope skill install, remove, check, or sync.");
    await installSkill(argument === "remove");
    return;
  }
  if (command === "voice") {
    if (argument === "guide") {
      console.log(JSON.stringify(VoiceGuide, null, 2));
      return;
    }
    const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"] ?? "330000"));
    await voiceCommand(argument, replacement, values, () => connect(values, signal), signal);
    return;
  }
  if (command === "pull-requests") {
    if (argument === "guide") {
      console.log(JSON.stringify(PullRequestsGuide, null, 2));
      return;
    }
    const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"] ?? "120000"));
    console.log(
      JSON.stringify(
        await pullRequestsCommand(await connect(values, signal), positionals, signal),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "retro") {
    if (argument === "guide") {
      console.log(JSON.stringify(RetroGuide, null, 2));
      return;
    }
    if (argument === "watch") {
      if (!replacement) throw new Error("Provide the retrospective name.");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await watchRetro(await connect(values, controller.signal), replacement, values, controller);
      } finally {
        controller.abort();
      }
    } else {
      const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"]));
      console.log(
        JSON.stringify(
          await retroCommand(await connect(values, signal), positionals, signal),
          null,
          2,
        ),
      );
    }
    return;
  }
  if (command === "librarian") {
    if (argument === "guide") {
      console.log(JSON.stringify(LibrarianGuide, null, 2));
      return;
    }
    const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"]));
    console.log(
      JSON.stringify(
        await librarianCommand(await connect(values, signal), argument ?? "", replacement, signal),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "memory") {
    if (argument === "guide") {
      console.log(JSON.stringify(MemoryGuide, null, 2));
      return;
    }
    const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"]));
    const client = await connect(values, signal);
    if (argument === "connect") {
      if (!replacement) throw new Error("Provide the memory repository as OWNER/NAME.");
      console.log(JSON.stringify(await client.connectMemory(replacement), null, 2));
      return;
    }
    if (argument !== "status") throw new Error("Use memory guide, status, or connect OWNER/REPO.");
    const status = await client.memory().catch(async (error: unknown) => {
      // A hub answers for its own machine while the Mac is offline.
      if (error instanceof ScopeError && error.status !== 503) throw error;
      const fallback = await connect(
        values,
        AbortSignal.timeout(parseTimeout(values["timeout-ms"])),
      );
      const local = await fallback.hubMemory().catch(() => {
        throw error;
      });
      return {
        macOffline:
          !(error instanceof ScopeError) || error.message.includes("paired Mac is disconnected"),
        desktopUnavailable: true,
        message: error instanceof Error ? error.message : "Could not read desktop memory status.",
        machine: local,
      };
    });
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (command === "plan") {
    if (argument === "guide") {
      console.log(JSON.stringify(PlanGuide, null, 2));
      return;
    }
    if (argument === "watch") {
      if (!replacement) throw new Error("Provide the plan name.");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await watchPlan(await connect(values, controller.signal), replacement, values, controller);
      } finally {
        controller.abort();
      }
    } else {
      const signal = AbortSignal.timeout(parseTimeout(values["timeout-ms"]));
      console.log(
        JSON.stringify(
          await planCommand(await connect(values, signal), positionals, values, signal),
          null,
          2,
        ),
      );
    }
    return;
  }
  const timeoutMs = validateArtifactCommand(command, argument, replacement, values);

  const signal = AbortSignal.timeout(timeoutMs);
  const commandDeadline = performance.now() + timeoutMs;
  let publicationId: string | undefined;
  try {
    const client = await connect(values, signal);
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
      console.log(JSON.stringify(await resolveArtifact(client, argument!), null, 2));
      return;
    }

    const publication = await preparePublication(
      client,
      positionals,
      values,
      signal,
      commandDeadline,
    );
    publicationId = publication.id;
    const artifact = await client.publishOrQueue(
      publication.id,
      publication.input,
      publication.content,
    );
    console.log(JSON.stringify(artifact, null, 2));
  } catch (error) {
    if (!signal.aborted) throw error;
    const outcome = publicationId
      ? ` Artifact ${publicationId} may have been published or buffered; read it or inspect hub queue before retrying.`
      : "";
    throw new Error(`Scope command timed out after ${timeoutMs} ms.${outcome}`, { cause: error });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Scope command failed."}\n`);
  process.exitCode = 1;
});
