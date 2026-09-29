import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decode } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import {
  VoiceRequest,
  VoiceRequestId,
  MAX_VOICE_TEXT_BYTES,
  type VoiceReceipt,
} from "@irudd-scope/protocol/voice";

export const voiceHelp = `irudd-scope voice generate TEXT.txt --output AUDIO.wav [--receipt RECEIPT.json]
  [--request-id ID] [--instructions TEXT] [--timeout-ms MS]
irudd-scope voice status ID [--refresh-billing] [--receipt RECEIPT.json]
irudd-scope voice result ID --output AUDIO.wav [--receipt RECEIPT.json]
irudd-scope voice cancel ID
irudd-scope voice guide

Generation waits up to 330000 ms by default using short submission/status/download requests.
Record --request-id before calling. Otherwise the CLI prints a new ID to stderr before submission.
Timeout or disconnection leaves generation running. Inspect the same ID; never regenerate automatically.
ID reuse with identical text/settings is safe for 24 hours. Different payloads conflict.
Results are WAV, 24 kHz mono signed 16-bit PCM. Output files must be new .wav files.
Billing may be pending after audio. status --refresh-billing starts a lookup; read status again later.
Cost is null until actual OpenRouter billing is available. Cancellation does not imply a refund.
Scope must run on an awake Mac with Voice generation enabled and a shared OpenRouter key.
`;

type VoiceOptions = {
  output?: string;
  receipt?: string;
  "request-id"?: string;
  instructions?: string;
  "refresh-billing"?: boolean;
};

export async function voiceCommand(
  action: string | undefined,
  argument: string | undefined,
  options: VoiceOptions,
  connect: () => Promise<ScopeClient>,
  signal: AbortSignal,
) {
  if (!["generate", "status", "result", "cancel"].includes(action ?? "") || !argument)
    throw new Error(voiceHelp);
  if (["generate", "result"].includes(action!)) {
    if (!options.output || extname(options.output).toLowerCase() !== ".wav")
      throw new Error("Speech output requires --output with a new .wav file.");
    const paths = [options.output, options.receipt, action === "generate" ? argument : undefined]
      .filter((path): path is string => Boolean(path))
      .map((path) => resolve(path));
    if (new Set(paths).size !== paths.length)
      throw new Error("Narration, audio, and receipt need separate files.");
    const exists = await stat(options.output).then(
      () => true,
      (error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) throw new Error("Speech output already exists. Choose a new .wav file.");
  }
  let receipt: VoiceReceipt;
  let requestId = action === "generate" ? (options["request-id"] ?? randomUUID()) : argument;
  requestId = decode(VoiceRequestId, requestId);
  let client: ScopeClient;
  try {
    if (action === "generate") {
      const info = await stat(argument);
      if (!info.isFile() || info.size > MAX_VOICE_TEXT_BYTES)
        throw new Error("Narration must be a text file no larger than 16 KiB UTF-8.");
      const text = await readFile(argument, { encoding: "utf8", signal });
      const input = decode(VoiceRequest, {
        requestId,
        text,
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
      });
      console.error(`Speech request ID: ${requestId}`);
      client = await connect();
      receipt = await client.submitVoice(input);
      if (options.receipt)
        await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + "\n", {
          mode: 0o600,
          signal,
        });
      while (receipt.state === "generating") {
        await delay(250, undefined, { signal });
        receipt = await client.voiceStatus(requestId);
      }
    } else {
      client = await connect();
      receipt =
        action === "cancel"
          ? await client.cancelVoice(requestId)
          : options["refresh-billing"]
            ? await client.refreshVoiceBilling(requestId)
            : await client.voiceStatus(requestId);
    }
    if (options.receipt)
      await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + "\n", {
        mode: 0o600,
        signal,
      });
    if (action === "generate" || action === "result") {
      if (receipt.state !== "succeeded")
        throw new Error(
          `Speech request is ${receipt.state}. ${receipt.error ?? "Inspect its status later."}`,
        );
      await writeFile(options.output!, await client.voiceResult(requestId), {
        flag: "wx",
        mode: 0o600,
        signal,
      });
    }
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Speech command failed."}\nInspect with: irudd-scope voice status ${requestId}. Do not submit a new ID automatically.`,
      { cause: error },
    );
  }
}
