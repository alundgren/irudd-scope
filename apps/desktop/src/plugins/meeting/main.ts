import { randomBytes, randomUUID } from "node:crypto";
import { app, systemPreferences } from "electron";
import type { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import type { MainPluginContext } from "../main-api.ts";
import {
  CODEX_MODEL,
  EditRequest,
  type EditResult,
  ExportRequest,
  MeetingSettings,
  TRANSCRIPTION_MODEL,
  TranscribeRequest,
  type TranscribeResult,
} from "./contract.ts";
import {
  codexEdit,
  MeetingBackendError,
  openRouterEdit,
  parseEditReply,
  resolveCodex,
  transcribe,
} from "./backends.ts";
import { meetingDebugLog } from "./debug-log.ts";
import { applyCanvasOps } from "./canvas.ts";
import { buildCanvasMessage, SYSTEM_PROMPT } from "./prompt.ts";

const NO_KEY = "Add an OpenRouter API key in Settings, then try again.";

function message(error: unknown, fallback: string) {
  return error instanceof MeetingBackendError ? error.message : fallback;
}

function input<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return decode(schema, value);
  } catch {
    // Schema errors quote the input, which can be megabytes of audio.
    throw new Error("Scope received an invalid Meeting canvas request.");
  }
}

/** A unique artifact name for each Keep, such as `meeting-canvas-20261103-164229-3fa2`. */
function keepName() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15)
    .toLowerCase();
  return `meeting-canvas-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function registerMeetingIpc({ handle, store, client, window }: MainPluginContext) {
  const log = meetingDebugLog(app.getPath("userData"));
  // Requests from a closed window or a crashed renderer stop instead of running to their timeout.
  let controller = new AbortController();
  const stop = () => {
    controller.abort();
    controller = new AbortController();
  };
  window.once("closed", stop);
  window.webContents.on("render-process-gone", stop);
  const key = async () => {
    const value = await store.secret("apiKey");
    if (!value) throw new MeetingBackendError(NO_KEY);
    return value;
  };

  handle("scope:meeting-listen-start", async () => {
    await key();
    if (process.platform === "darwin" && !(await systemPreferences.askForMediaAccess("microphone")))
      throw new Error(
        "Microphone access is off. Allow Scope in System Settings, Privacy & Security, Microphone.",
      );
  });

  handle("scope:meeting-transcribe", async (value): Promise<TranscribeResult> => {
    const request = input(TranscribeRequest, value);
    try {
      const result = await transcribe({
        key: await key(),
        model: TRANSCRIPTION_MODEL,
        wavBase64: request.audio,
        language: request.language || undefined,
        signal: controller.signal,
      });
      log.write({
        type: "transcribe",
        model: TRANSCRIPTION_MODEL,
        ms: result.ms,
        text: result.text,
      });
      return { text: result.text, ms: result.ms, model: TRANSCRIPTION_MODEL };
    } catch (error) {
      const text = message(error, "Transcription failed.");
      log.write({ type: "transcribe", model: TRANSCRIPTION_MODEL, error: text });
      throw new Error(text);
    }
  });

  handle("scope:meeting-edit", async (value): Promise<EditResult> => {
    const request = input(EditRequest, value);
    const { backend } = request.settings;
    const model = backend === "codex" ? CODEX_MODEL : request.settings.openrouterModel;
    const user = buildCanvasMessage(request);
    const entry = {
      type: "edit",
      backend,
      model,
      requestChars: SYSTEM_PROMPT.length + user.length,
      request: request.request,
      recentLines: request.recent.length,
      focus: request.focus,
      sections: request.canvas.sections.length,
      closedBy: request.closedBy,
    };
    // The detector sent this request on its 6 s timer while the room still sounded busy.
    if (request.closedBy === "fallback")
      log.write({ type: "wake-fallback", request: request.request });
    try {
      const reply =
        backend === "codex"
          ? await codexEdit({
              codexPath: await resolveCodex(request.settings.codexPath),
              system: SYSTEM_PROMPT,
              user,
              signal: controller.signal,
            })
          : await openRouterEdit({
              key: await key(),
              model,
              system: SYSTEM_PROMPT,
              user,
              signal: controller.signal,
            });
      const { ops } = parseEditReply(reply.content);
      // The renderer applies ops to its latest canvas; this records what the request canvas rejects.
      const rejected = applyCanvasOps(request.canvas, ops, request.focus).rejected;
      log.write({ ...entry, ms: reply.ms, ops, rejected });
      return { ops, ms: reply.ms, backend, model };
    } catch (error) {
      const text = message(error, "The canvas edit failed.");
      log.write({ ...entry, error: text });
      throw new Error(text);
    }
  });

  handle("scope:meeting-export", async (value) => {
    const request = input(ExportRequest, value);
    const name = keepName();
    // Publishing reserves a new tab, so the kept canvas opens like any published artifact.
    return client.publish(
      randomUUID(),
      {
        name,
        title: request.title,
        kind: "html",
        mediaType: "text/html",
        fileName: `${name}.html`,
        expectedRevision: 0,
      },
      Buffer.from(request.html),
    );
  });

  handle(
    "scope:meeting-codex-status",
    async (value): Promise<{ path?: string; error?: string }> => {
      const override = input(MeetingSettings.fields.codexPath, value);
      try {
        return { path: await resolveCodex(override) };
      } catch (error) {
        return { error: message(error, "Codex was not found.") };
      }
    },
  );
}
