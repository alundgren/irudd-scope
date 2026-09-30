import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { readRemoteJson } from "@irudd-scope/protocol/remote";
import {
  MAX_VOICE_AUDIO_BYTES,
  VOICE_MODEL,
  VOICE,
  VOICE_SOLO_INSTRUCTIONS,
  type VoiceRequest,
} from "@irudd-scope/protocol/voice";
import { speechWav } from "./audio.ts";

const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Generation = Schema.Struct({
  data: Schema.Struct({
    id: identifier,
    model: Schema.optionalKey(identifier),
    provider_name: Schema.optionalKey(Schema.NullOr(identifier)),
    total_cost: Schema.optionalKey(
      Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
    ),
  }),
});

export function voiceProvider(fetcher: typeof fetch = (...args) => fetch(...args)) {
  return {
    async generate(
      key: string,
      request: VoiceRequest,
      signal: AbortSignal,
      received: (id: string | null) => Promise<void>,
    ) {
      const response = await fetcher("https://openrouter.ai/api/v1/audio/speech", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VOICE_MODEL,
          input: request.text,
          voice: request.voice ?? VOICE,
          response_format: "pcm",
          provider: {
            order: ["google-ai-studio"],
            allow_fallbacks: false,
            options: {
              "google-ai-studio": {
                speech_metadata: {
                  style: request.instructions?.trim()
                    ? request.instructions
                    : VOICE_SOLO_INSTRUCTIONS,
                },
              },
            },
          },
        }),
      });
      const id = response.headers.get("x-generation-id");
      await received(id ? decode(identifier, id) : null);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OpenRouter speech returned HTTP ${response.status}. No retry was made.`);
      }
      const mediaType = response.headers.get("content-type") ?? "";
      if (!["audio/pcm", "audio/wav"].includes(mediaType.split(";")[0].trim())) {
        await response.body?.cancel();
        throw new Error("OpenRouter returned an unsupported audio media type.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("OpenRouter returned no audio.");
      const parts: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size + 44 > MAX_VOICE_AUDIO_BYTES)
            throw new Error("OpenRouter audio exceeds the transfer limit.");
          parts.push(Buffer.from(part.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return speechWav(Buffer.concat(parts), mediaType);
    },
    async billing(key: string, generationId: string, signal: AbortSignal) {
      const response = await fetcher(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        {
          redirect: "error",
          signal,
          headers: { Authorization: `Bearer ${key}` },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      // Generation metadata includes unrelated usage fields; retain only receipt fields.
      const value = Schema.decodeUnknownSync(Generation)(await readRemoteJson(response));
      if (value.data.id !== generationId)
        throw new Error("OpenRouter returned a different generation.");
      return value.data;
    },
  };
}
export type VoiceProvider = ReturnType<typeof voiceProvider>;
