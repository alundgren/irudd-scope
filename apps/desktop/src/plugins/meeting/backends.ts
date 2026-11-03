import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import {
  CODEX_EFFORT,
  CODEX_MODEL,
  CODEX_SERVICE_TIER,
  EDIT_REPLY_JSON_SCHEMA,
  EditReply,
} from "./contract.ts";

// Node only: the bench tool imports this file, so it must not import Electron.

const OPENROUTER = "https://openrouter.ai/api/v1";
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const EDIT_TIMEOUT_MS = 45_000;
const CODEX_TIMEOUT_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_REPLY_BYTES = 256 * 1024;

/** A failure whose message is short, readable and safe to show and log. */
export class MeetingBackendError extends Error {}

const Transcription = Schema.Struct({ text: Schema.String });
const Completion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ content: Schema.NullOr(Schema.String) }) }),
  ),
});

async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit)
        throw new MeetingBackendError("OpenRouter sent a reply that is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function httpMessage(status: number) {
  if (status === 401 || status === 403)
    return `OpenRouter rejected the API key (HTTP ${status}). Check it in Settings.`;
  if (status === 402) return "OpenRouter needs more credits (HTTP 402).";
  if (status === 429) return "OpenRouter is rate limiting requests (HTTP 429).";
  return `OpenRouter returned HTTP ${status}.`;
}

async function openRouterPost(input: {
  path: string;
  key: string;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  limit: number;
}): Promise<string> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    const response = await fetch(`${OPENROUTER}${input.path}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${input.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(input.body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MeetingBackendError(httpMessage(response.status));
    }
    return await readCapped(response, input.limit);
  } catch (error) {
    if (error instanceof MeetingBackendError) throw error;
    if (input.signal?.aborted) throw new MeetingBackendError("Stopped.");
    if (timeout.aborted)
      throw new MeetingBackendError(
        `OpenRouter did not answer within ${input.timeoutMs / 1000} s.`,
      );
    throw new MeetingBackendError("Could not reach OpenRouter. Check the connection.");
  }
}

export async function transcribe(input: {
  key: string;
  model: string;
  wavBase64: string;
  language?: string;
  signal?: AbortSignal;
}): Promise<{ text: string; ms: number }> {
  const started = performance.now();
  const text = await openRouterPost({
    path: "/audio/transcriptions",
    key: input.key,
    signal: input.signal,
    timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    limit: 64 * 1024,
    body: {
      model: input.model,
      input_audio: { data: input.wavBase64, format: "wav" },
      ...(input.language ? { language: input.language } : {}),
    },
  });
  let reply: typeof Transcription.Type;
  try {
    reply = Schema.decodeUnknownSync(Transcription)(JSON.parse(text));
  } catch {
    throw new MeetingBackendError("OpenRouter sent a transcription Scope cannot read.");
  }
  return { text: reply.text.trim(), ms: Math.round(performance.now() - started) };
}

export async function openRouterEdit(input: {
  key: string;
  model: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}): Promise<{ content: string; ms: number }> {
  const started = performance.now();
  const text = await openRouterPost({
    path: "/chat/completions",
    key: input.key,
    signal: input.signal,
    timeoutMs: EDIT_TIMEOUT_MS,
    limit: MAX_REPLY_BYTES,
    body: {
      model: input.model,
      temperature: 0.2,
      provider: { require_parameters: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: "meeting_edit", strict: true, schema: EDIT_REPLY_JSON_SCHEMA },
      },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    },
  });
  let content: string | null | undefined;
  try {
    content = Schema.decodeUnknownSync(Completion)(JSON.parse(text)).choices[0]?.message.content;
  } catch {
    throw new MeetingBackendError("OpenRouter sent a reply Scope cannot read.");
  }
  if (!content) throw new MeetingBackendError("The model returned no page changes.");
  return { content, ms: Math.round(performance.now() - started) };
}

/** Reads the model's JSON reply. Tolerates a Markdown code fence around the object. */
export function parseEditReply(content: string): EditReply {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    try {
      value = JSON.parse(content.slice(start, end + 1));
    } catch {
      throw new MeetingBackendError("The model reply is not JSON.");
    }
  }
  try {
    return Schema.decodeUnknownSync(EditReply)(value);
  } catch {
    throw new MeetingBackendError("The model reply does not match the page edit format.");
  }
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export async function codexEdit(input: {
  codexPath: string;
  system: string;
  user: string;
  signal?: AbortSignal;
}): Promise<{ content: string; ms: number }> {
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "scope-meeting-codex-"));
  // Codex runs in an empty folder so it has no project files to read.
  const work = join(directory, "work");
  const schema = join(directory, "schema.json");
  const last = join(directory, "last.txt");
  try {
    await mkdir(work);
    await writeFile(schema, JSON.stringify(EDIT_REPLY_JSON_SCHEMA));
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "-s",
      "read-only",
      "-m",
      CODEX_MODEL,
      "-c",
      `model_reasoning_effort="${CODEX_EFFORT}"`,
      "-c",
      `service_tier="${CODEX_SERVICE_TIER}"`,
      "--output-schema",
      schema,
      "-o",
      last,
      "-",
    ];
    const prompt = `Answer directly with the JSON. Do not run commands.\n\n${input.system}\n\n${input.user}`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(input.codexPath, args, {
        cwd: work,
        stdio: ["pipe", "ignore", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", aborted);
        if (error) {
          killTree(child.pid);
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new MeetingBackendError(`Codex did not answer within ${CODEX_TIMEOUT_MS / 1000} s.`),
          ),
        CODEX_TIMEOUT_MS,
      );
      const aborted = () => finish(new MeetingBackendError("Stopped."));
      if (input.signal?.aborted) return aborted();
      input.signal?.addEventListener("abort", aborted, { once: true });
      child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-4000);
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        finish(
          new MeetingBackendError(
            error.code === "ENOENT"
              ? `Codex was not found at ${input.codexPath}.`
              : "Could not start Codex.",
          ),
        ),
      );
      child.on("close", (code) => {
        if (code === 0) return finish();
        const detail = stderr
          .split("\n")
          .reverse()
          .find((line) => /error/i.test(line))
          ?.trim()
          .slice(0, 160);
        finish(
          new MeetingBackendError(`Codex exited with code ${code}.${detail ? ` ${detail}` : ""}`),
        );
      });
      // Codex waits for stdin to close before it starts.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    const content = await readFile(last, "utf8").catch(() => {
      throw new MeetingBackendError("Codex finished without a reply.");
    });
    if (!content.trim()) throw new MeetingBackendError("Codex finished without a reply.");
    return { content, ms: Math.round(performance.now() - started) };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function executable(path: string) {
  if (!path || !isAbsolute(path)) return false;
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookup(file: string, args: string[]) {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      file,
      args,
      { timeout: LOOKUP_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        // Interactive shells can print banners; the path is the last line.
        const lines = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(lines.at(-1));
      },
    );
  });
}

let found: string | undefined;

/**
 * Finds the codex binary. An app opened from Finder has no shell PATH, so this asks the
 * person's login shell, then an interactive one, then tries the usual install folders.
 */
export async function resolveCodex(override: string): Promise<string> {
  if (override) {
    if (await executable(override)) return override;
    throw new MeetingBackendError(`No codex program at ${override}.`);
  }
  if (found && (await executable(found))) return found;
  const candidates: (() => Promise<string | undefined>)[] = [];
  if (process.platform === "win32") candidates.push(() => lookup("where.exe", ["codex"]));
  else {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    candidates.push(
      () => lookup(shell, ["-lc", "command -v codex"]),
      () => lookup(shell, ["-ilc", "command -v codex"]),
    );
  }
  for (const path of [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(homedir(), ".local", "bin", "codex"),
  ])
    candidates.push(async () => path);
  for (const candidate of candidates) {
    const path = await candidate();
    if (path && (await executable(path))) {
      found = path;
      return path;
    }
  }
  throw new MeetingBackendError("Codex was not found. Enter the path to the codex program.");
}
