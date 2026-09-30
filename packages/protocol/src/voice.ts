import { Schema } from "effect";

export const VOICE_MODEL = "google/gemini-3.8-flash-tts";
export const VOICE = "Aoede";
export const VoiceName = Schema.Literals(["Aoede", "Leda", "Kore"]);
export const VOICE_SOLO_INSTRUCTIONS =
  "An experienced developer talking through a first impression with a familiar colleague. Dry, low-key delivery. Let easy phrases run together, briefly hesitate at a question, and emphasize only the point being worked out. Incidental asides. Keep the performance restrained. Let the mood follow the content.";
export const VOICE_CONVERSATION_PRIMARY_INSTRUCTIONS =
  "Thinking aloud to a colleague. Dry, low-key delivery. Ordinary conversational volume, uneven pacing, restrained emphasis. Let the mood follow the content.";
export const VOICE_CONVERSATION_SECONDARY_INSTRUCTIONS =
  "Curious and matter-of-fact, replying to a colleague. Casual conversational volume, light questioning inflection, understated delivery. Let the mood follow the content.";
export const MAX_VOICE_TEXT_BYTES = 16 * 1024;
export const MAX_VOICE_REQUEST_BYTES = 128 * 1024;
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
export const VOICE_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_VOICE_CONCURRENT = 2;
export const VOICE_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

export const VoiceRequestId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
);
export const VoiceRequest = Schema.Struct({
  requestId: VoiceRequestId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_VOICE_TEXT_BYTES)),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  voice: Schema.optionalKey(VoiceName),
});
export type VoiceRequest = typeof VoiceRequest.Type;

const nonnegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const VoiceReceipt = Schema.Struct({
  requestId: VoiceRequestId,
  state: Schema.Literals(["generating", "succeeded", "failed", "canceled", "interrupted"]),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  requestedModel: Schema.Literal(VOICE_MODEL),
  generationId: Schema.NullOr(identifier),
  model: Schema.NullOr(identifier),
  provider: Schema.NullOr(identifier),
  voice: VoiceName,
  audioFormat: Schema.NullOr(Schema.Literal("wav")),
  mediaType: Schema.NullOr(Schema.Literal("audio/wav")),
  sampleRate: Schema.NullOr(Schema.Literal(24000)),
  channels: Schema.NullOr(Schema.Literal(1)),
  bitsPerSample: Schema.NullOr(Schema.Literal(16)),
  durationSeconds: Schema.NullOr(nonnegative),
  elapsedGenerationMs: Schema.NullOr(nonnegative),
  costUsd: Schema.NullOr(nonnegative),
  billingStatus: Schema.Literals(["pending", "known", "unavailable"]),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export type VoiceReceipt = typeof VoiceReceipt.Type;

export const VoiceGuide = {
  generate:
    "voice generate TEXT.txt --request-id ID --output AUDIO.wav --receipt RECEIPT.json [--voice Aoede|Leda|Kore] [--instructions TEXT]. Uses Gemini 3.8 Flash TTS. New requests default to Aoede with restrained conversational delivery; omitted or blank instructions use the solo style. Only supplied narration and speech settings go to OpenRouter. Enable Voice generation and save the shared OpenRouter key in desktop Settings first.",
  styles: {
    solo: { voice: VOICE, instructions: VOICE_SOLO_INSTRUCTIONS },
    conversation: {
      primary: { voice: VOICE, instructions: VOICE_CONVERSATION_PRIMARY_INSTRUCTIONS },
      secondary: { voice: "Leda", instructions: VOICE_CONVERSATION_SECONDARY_INSTRUCTIONS },
      gapMs: 180,
      workflow:
        "Generate each speaker turn separately with its role's voice and instructions and a recorded unique request ID. Join exported WAVs in script order with 180 ms silence between turns. This is assembled dialogue, without native overlap. Write responses that answer or question the preceding point, not alternating monologues. See the Scope skill's podcast reference and join-wav.py helper.",
    },
  },
  recovery:
    "Choose and record a unique request ID before submission. generate prints the ID to stderr before contacting Scope. After a lost response or timeout, use voice status ID, then voice result ID --output AUDIO.wav --receipt RECEIPT.json. Repeating generate with the same ID and identical payload returns the existing request for 24 hours. Conflicting reuse is rejected. Never choose a new ID automatically after an uncertain outcome. After expiry, even an old ID can cause a new paid call.",
  billing:
    "voice status ID --refresh-billing --receipt RECEIPT.json refreshes actual OpenRouter data.total_cost without generating speech. Cost stays null until known; model and provider are actual lookup values and remain null until available. Audio is downloadable while billing is pending.",
  cancellation:
    "voice cancel ID stops local generation if still active. CLI timeout, exit, lost responses, and hub disconnection do not cancel generation. Cancellation and provider failures may still incur a charge. A generation has a five-minute desktop deadline. Interrupted requests after desktop restart never resume or regenerate; completed results survive restart.",
  limits:
    "Scope must be running on an awake Mac. No offline queue. Narration: 16 KiB UTF-8; instructions: 2048 characters; two concurrent generations; no retained request count limit; 16 MiB per WAV; 24 hours from submission for IDs, receipts, and results. Download and billing refresh never generate speech. Agents own exported files, scripts, HTML, synchronization, and playback.",
};
