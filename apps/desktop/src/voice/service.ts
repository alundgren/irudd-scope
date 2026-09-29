import { createHash } from "node:crypto";
import { decode, ScopeError } from "@irudd-scope/protocol";
import {
  VoiceRequest,
  VoiceReceipt,
  VOICE,
  VOICE_MODEL,
  VOICE_LIFETIME_MS,
  VOICE_GENERATION_TIMEOUT_MS,
  MAX_VOICE_CONCURRENT,
  MAX_VOICE_REQUESTS,
  MAX_VOICE_TEXT_BYTES,
} from "@irudd-scope/protocol/voice";
import type { DesktopStore } from "../desktop-store.ts";
import { voiceProvider, type VoiceProvider } from "./openrouter.ts";

type MutableReceipt = { -readonly [Key in keyof VoiceReceipt]: VoiceReceipt[Key] };

type Entry = {
  hash: string;
  expiresAt: number;
  receipt: MutableReceipt;
  controller?: AbortController;
};

export class VoiceService {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  private readonly billing = new Map<string, number>();
  private operations = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;

  constructor(
    private readonly store: DesktopStore,
    private readonly provider: VoiceProvider = voiceProvider(),
  ) {}

  async start() {
    await this.store.expireVoice(Date.now());
    for (const row of await this.store.voiceRows()) {
      const receipt: MutableReceipt = decode(VoiceReceipt, JSON.parse(row.receipt));
      const entry = { hash: row.payload_hash, expiresAt: row.expires_at, receipt };
      this.entries.set(row.request_id, entry);
      if (receipt.state === "generating") {
        receipt.state = "interrupted";
        receipt.error =
          "Desktop restarted before completion. The provider outcome and charge may be uncertain. No retry was made.";
        await this.save(entry);
      }
    }
    this.timer = setInterval(() => {
      this.track(this.exclusive(() => this.expire()));
    }, 60_000);
    this.timer.unref();
  }

  private exclusive<A>(work: () => Promise<A>): Promise<A> {
    const task = this.operations.then(work);
    this.operations = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private track(task: Promise<void>) {
    const tracked = task
      .catch(() => {
        console.error(
          "Scope could not save or refresh a speech request. Inspect its status before resubmitting.",
        );
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private save(entry: Entry, audio?: Buffer) {
    if (this.entries.get(entry.receipt.requestId) !== entry || entry.expiresAt <= Date.now())
      return Promise.resolve();
    return this.store.saveVoice(
      entry.receipt.requestId,
      entry.hash,
      entry.expiresAt,
      JSON.stringify(decode(VoiceReceipt, entry.receipt)),
      audio,
    );
  }

  private async expire() {
    const now = Date.now();
    await this.store.expireVoice(now);
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        entry.controller?.abort();
        this.entries.delete(id);
        this.billing.delete(id);
      }
    }
  }

  private get(id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.expiresAt <= Date.now())
      throw new ScopeError(
        404,
        "Speech request not found or expired. Do not regenerate automatically after an uncertain outcome.",
      );
    return entry;
  }

  submit(value: VoiceRequest): Promise<VoiceReceipt> {
    const input = decode(VoiceRequest, value);
    if (!input.text.trim()) throw new ScopeError(400, "Narration must contain text.");
    if (Buffer.byteLength(input.text, "utf8") > MAX_VOICE_TEXT_BYTES)
      throw new ScopeError(413, "Narration exceeds 16 KiB UTF-8.");
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          text: input.text,
          instructions: input.instructions ?? "",
          voice: input.voice ?? VOICE,
          model: VOICE_MODEL,
        }),
      )
      .digest("hex");
    return this.exclusive(async () => {
      await this.expire();
      const existing = this.entries.get(input.requestId);
      if (existing) {
        if (existing.hash !== hash)
          throw new ScopeError(
            409,
            "Request ID already has different narration or speech settings.",
          );
        return structuredClone(existing.receipt);
      }
      if (this.closing) throw new ScopeError(503, "Scope is shutting down.");
      if (!this.store.settings().voiceGenerationEnabled)
        throw new ScopeError(403, "Enable voice generation in desktop Settings first.");
      if (this.entries.size >= MAX_VOICE_REQUESTS)
        throw new ScopeError(
          429,
          "Speech request retention is full. Wait for a request to expire.",
        );
      if (
        [...this.entries.values()].filter((entry) => entry.controller).length >=
        MAX_VOICE_CONCURRENT
      )
        throw new ScopeError(
          429,
          "Two speech generations are already active. No request was queued.",
        );
      const now = Date.now();
      const entry: Entry = {
        hash,
        expiresAt: now + VOICE_LIFETIME_MS,
        controller: new AbortController(),
        receipt: {
          requestId: input.requestId,
          state: "generating",
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + VOICE_LIFETIME_MS).toISOString(),
          requestedModel: VOICE_MODEL,
          generationId: null,
          model: null,
          provider: null,
          voice: VOICE,
          audioFormat: null,
          mediaType: null,
          sampleRate: null,
          channels: null,
          bitsPerSample: null,
          durationSeconds: null,
          elapsedGenerationMs: null,
          costUsd: null,
          billingStatus: "pending",
        },
      };
      // Commit the caller's ID before any paid provider call, including when the HTTP reply is lost.
      this.entries.set(input.requestId, entry);
      try {
        await this.save(entry);
      } catch (error) {
        this.entries.delete(input.requestId);
        throw error;
      }
      this.track(this.generate(entry, input));
      return structuredClone(entry.receipt);
    });
  }

  status(id: string): Promise<VoiceReceipt> {
    return this.exclusive(async () => structuredClone(this.get(id).receipt));
  }

  result(id: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      if (this.get(id).receipt.state !== "succeeded")
        throw new ScopeError(409, "Speech has no completed audio result. Inspect the receipt.");
      const bytes = await this.store.voiceAudio(id);
      if (!bytes) throw new ScopeError(404, "Speech result is unavailable.");
      return bytes;
    });
  }

  cancel(id: string): Promise<VoiceReceipt> {
    return this.exclusive(async () => {
      const entry = this.get(id);
      if (entry.receipt.state === "generating") {
        entry.receipt.state = "canceled";
        entry.receipt.error =
          "Canceled locally. The provider may still charge this request; cancellation does not imply a refund.";
        entry.controller?.abort();
        await this.save(entry);
      }
      return structuredClone(entry.receipt);
    });
  }

  refreshBilling(id: string): Promise<VoiceReceipt> {
    return this.exclusive(async () => {
      const entry = this.get(id);
      this.requestBilling(entry);
      return structuredClone(entry.receipt);
    });
  }

  private requestBilling(entry: Entry) {
    const id = entry.receipt.requestId;
    if (
      this.closing ||
      this.entries.get(id) !== entry ||
      entry.expiresAt <= Date.now() ||
      !entry.receipt.generationId ||
      (entry.receipt.billingStatus === "known" &&
        entry.receipt.model !== null &&
        entry.receipt.provider !== null) ||
      Date.now() < (this.billing.get(id) ?? 0)
    )
      return;
    this.billing.set(id, Infinity);
    this.track(
      this.lookupBilling(entry).finally(() => {
        if (this.entries.get(id) === entry) this.billing.set(id, Date.now() + 5000);
      }),
    );
  }

  private async lookupBilling(entry: Entry) {
    try {
      const key = await this.store.secret("apiKey");
      if (!key) return;
      const value = await this.provider.billing(
        key,
        entry.receipt.generationId!,
        AbortSignal.timeout(10_000),
      );
      if (!value) return;
      await this.exclusive(async () => {
        if (this.entries.get(entry.receipt.requestId) !== entry || entry.expiresAt <= Date.now())
          return;
        entry.receipt.model = value.model ?? entry.receipt.model;
        entry.receipt.provider = value.provider_name ?? entry.receipt.provider;
        if (value.total_cost !== undefined && value.total_cost !== null) {
          entry.receipt.costUsd = value.total_cost;
          entry.receipt.billingStatus = "known";
        }
        await this.save(entry);
      });
    } catch {
      // Billing failures leave the cost unknown and can be refreshed without another generation.
    }
  }

  private async generate(entry: Entry, input: VoiceRequest) {
    const started = performance.now();
    const signal = AbortSignal.any([
      entry.controller!.signal,
      AbortSignal.timeout(VOICE_GENERATION_TIMEOUT_MS),
    ]);
    try {
      const key = await this.store.secret("apiKey");
      signal.throwIfAborted();
      if (!this.store.settings().voiceGenerationEnabled)
        throw new Error("Voice generation was disabled before submission to OpenRouter.");
      if (!key) throw new Error("Add an OpenRouter key in desktop Settings first.");
      const audio = await this.provider.generate(key, input, signal, (id) =>
        this.exclusive(async () => {
          entry.receipt.generationId = id;
          if (!id) entry.receipt.billingStatus = "unavailable";
          await this.save(entry);
        }),
      );
      signal.throwIfAborted();
      await this.exclusive(async () => {
        if (
          entry.receipt.state !== "generating" ||
          this.entries.get(entry.receipt.requestId) !== entry ||
          entry.expiresAt <= Date.now()
        )
          return;
        const receipt: MutableReceipt = {
          ...entry.receipt,
          state: "succeeded",
          audioFormat: "wav",
          mediaType: "audio/wav",
          sampleRate: 24000,
          channels: 1,
          bitsPerSample: 16,
          durationSeconds: audio.durationSeconds,
          elapsedGenerationMs: performance.now() - started,
        };
        await this.store.saveVoice(
          entry.receipt.requestId,
          entry.hash,
          entry.expiresAt,
          JSON.stringify(decode(VoiceReceipt, receipt)),
          audio.bytes,
        );
        entry.receipt = receipt;
      });
    } catch (error) {
      await this.exclusive(async () => {
        if (entry.receipt.state !== "generating") return;
        entry.receipt.state = signal.aborted ? "interrupted" : "failed";
        entry.receipt.error = signal.aborted
          ? "Generation timed out or Scope stopped. Provider outcome and charge may be uncertain. No retry was made."
          : error instanceof Error && error.message.startsWith("OpenRouter")
            ? error.message.slice(0, 512)
            : "Speech generation failed. Check the shared key and speech settings. No retry was made; a provider charge may still apply.";
        entry.receipt.elapsedGenerationMs = performance.now() - started;
        await this.save(entry);
      });
    } finally {
      await this.exclusive(async () => {
        entry.controller = undefined;
        if (!entry.receipt.generationId) entry.receipt.billingStatus = "unavailable";
        if (entry.receipt.elapsedGenerationMs === null) {
          entry.receipt.elapsedGenerationMs = performance.now() - started;
          await this.save(entry);
        }
        this.requestBilling(entry);
      });
    }
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await this.operations;
    for (const entry of this.entries.values()) entry.controller?.abort();
    while (this.pending.size) await Promise.all(this.pending);
    await this.operations;
  }
}
