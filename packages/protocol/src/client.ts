import {
  PromptCommand,
  PromptReply,
  PromptItemId,
  MAX_PROMPT_REQUEST_BYTES,
  MAX_PROMPT_REPLY_BYTES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_EXPORT_BYTES,
} from "./prompts.ts";
import {
  RetroCommand,
  RetroReply,
  MAX_RETRO_REQUEST_BYTES,
  MAX_RETRO_REPLY_BYTES,
} from "./retro.ts";
import { LibrarianCommand, LibrarianReply } from "./librarian.ts";
import {
  PullRequestsCommand,
  PullRequestsReply,
  MAX_PULL_REQUESTS_REQUEST_BYTES,
  MAX_PULL_REQUESTS_REPLY_BYTES,
} from "./pull-requests.ts";
import {
  VoiceRequest,
  VoiceRequestId,
  VoiceReceipt,
  MAX_VOICE_AUDIO_BYTES,
  MAX_VOICE_REQUEST_BYTES,
} from "./voice.ts";
import { readRemoteJson } from "./remote.ts";
import {
  MemoryConnectRequest,
  MemoryMachineStatus,
  MemoryStatus,
  MAX_MEMORY_STATUS_BYTES,
} from "./memory.ts";
import {
  decodeTransferImportRequest,
  TransferImportReceipt,
  MAX_TRANSFER_IMPORT_REQUEST_BYTES,
  MAX_TRANSFER_IMPORT_REPLY_BYTES,
  TRANSFER_IMPORT_TIMEOUT_MS,
} from "./transfer.ts";
import {
  ShrinkRequest,
  ShrinkReceipt,
  MaintenanceStatus,
  MAINTENANCE_TIMEOUT_MS,
} from "./maintenance.ts";
import {
  Artifact,
  ArtifactId,
  ArtifactName,
  BlobId,
  ArtifactPage,
  ArtifactWrite,
  BlobReceipt,
  DeleteReceipt,
  HubQueue,
  PublicationReceipt,
  PublicationRequest,
  PublicationResult,
  LiveEvent,
  decodeLiveEvent,
  MAX_CONTENT_BYTES,
  ScopeError,
  UPDATE_BASE_HEADER,
  decode,
  validateEndpoint,
} from "./index.ts";

export class ScopeClient {
  readonly endpoint: string;
  private readonly token: string;
  private readonly signal?: AbortSignal;
  constructor(endpoint: string, token: string, options: { signal?: AbortSignal } = {}) {
    this.token = token;
    this.signal = options.signal;
    this.endpoint = validateEndpoint(endpoint);
    if (!token || /[\r\n]/.test(token)) throw new Error("A bearer token is required.");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    const signal = this.signal
      ? init.signal
        ? AbortSignal.any([this.signal, init.signal])
        : this.signal
      : (init.signal ?? AbortSignal.timeout(30_000));
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      redirect: "error",
      signal,
      headers,
    }).catch((error: unknown) => {
      if (this.signal?.aborted || init.signal?.aborted) throw error;
      throw new Error(
        `Cannot reach Scope at ${this.endpoint}. Start Scope or the paired hub and retry. Check the artifact or hub queue before retrying an uncertain publication.`,
        { cause: error },
      );
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      });
      const message =
        body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : `Scope returned ${response.status}.`;
      throw new ScopeError(response.status, message);
    }
    return response;
  }

  async importLink(url: string): Promise<TransferImportReceipt> {
    const body = JSON.stringify(decodeTransferImportRequest({ url }));
    if (new TextEncoder().encode(body).byteLength > MAX_TRANSFER_IMPORT_REQUEST_BYTES)
      throw new Error("Transfer import request exceeds 16 KiB.");
    return decode(
      TransferImportReceipt,
      await readRemoteJson(
        await this.request("/v1/transfers/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(TRANSFER_IMPORT_TIMEOUT_MS),
        }),
        MAX_TRANSFER_IMPORT_REPLY_BYTES,
      ),
    );
  }

  async retro(input: RetroCommand): Promise<RetroReply> {
    const body = JSON.stringify(decode(RetroCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_RETRO_REQUEST_BYTES)
      throw new Error("Retrospective command exceeds 2 MiB.");
    return decode(
      RetroReply,
      await readRemoteJson(
        await this.request("/v1/retros", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_RETRO_REPLY_BYTES,
      ),
    );
  }

  async prompts(input: PromptCommand): Promise<PromptReply> {
    const body = JSON.stringify(decode(PromptCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_PROMPT_REQUEST_BYTES)
      throw new Error("Prompt command exceeds 12 MiB.");
    return decode(
      PromptReply,
      await readRemoteJson(
        await this.request("/v1/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_PROMPT_REPLY_BYTES,
      ),
    );
  }
  async promptImage(itemId: string, imageId: string): Promise<Uint8Array> {
    return this.promptBytes(
      `/v1/prompts/items/${decode(PromptItemId, itemId)}/images/${decode(BlobId, imageId)}`,
      MAX_PROMPT_IMAGE_BYTES,
    );
  }
  async exportPromptLibrary(): Promise<Uint8Array> {
    return this.promptBytes("/v1/prompts/export", MAX_PROMPT_EXPORT_BYTES);
  }
  private async promptBytes(path: string, limit: number): Promise<Uint8Array> {
    const response = await this.request(path);
    if (!response.body) throw new Error("Scope returned empty prompt content.");
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("Scope returned oversized prompt content.");
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }

  async librarian(input: LibrarianCommand): Promise<LibrarianReply> {
    const body = JSON.stringify(decode(LibrarianCommand, input));
    if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024)
      throw new Error("Librarian command exceeds 2 MiB.");
    return decode(
      LibrarianReply,
      await readRemoteJson(
        await this.request("/v1/librarian", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        16 * 1024 * 1024,
      ),
    );
  }

  async pullRequests(input: PullRequestsCommand): Promise<PullRequestsReply> {
    const body = JSON.stringify(decode(PullRequestsCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_PULL_REQUESTS_REQUEST_BYTES)
      throw new Error("Pull request command exceeds 256 KiB.");
    return decode(
      PullRequestsReply,
      await readRemoteJson(
        await this.request("/v1/pull-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_PULL_REQUESTS_REPLY_BYTES,
      ),
    );
  }

  async submitVoice(input: VoiceRequest): Promise<VoiceReceipt> {
    const body = JSON.stringify(decode(VoiceRequest, input));
    if (new TextEncoder().encode(body).byteLength > MAX_VOICE_REQUEST_BYTES)
      throw new Error("Speech request exceeds 128 KiB.");
    return decode(
      VoiceReceipt,
      await readRemoteJson(
        await this.request("/v1/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      ),
    );
  }

  async voiceStatus(requestId: string): Promise<VoiceReceipt> {
    return decode(
      VoiceReceipt,
      await readRemoteJson(await this.request(`/v1/voice/${decode(VoiceRequestId, requestId)}`)),
    );
  }

  async refreshVoiceBilling(requestId: string): Promise<VoiceReceipt> {
    return decode(
      VoiceReceipt,
      await readRemoteJson(
        await this.request(`/v1/voice/${decode(VoiceRequestId, requestId)}/billing`, {
          method: "POST",
        }),
      ),
    );
  }

  async cancelVoice(requestId: string): Promise<VoiceReceipt> {
    return decode(
      VoiceReceipt,
      await readRemoteJson(
        await this.request(`/v1/voice/${decode(VoiceRequestId, requestId)}`, { method: "DELETE" }),
      ),
    );
  }

  async voiceResult(requestId: string): Promise<Uint8Array> {
    const response = await this.request(`/v1/voice/${decode(VoiceRequestId, requestId)}/result`);
    if (response.headers.get("content-type") !== "audio/wav")
      throw new Error("Scope returned an unexpected speech media type.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Scope returned no audio.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_VOICE_AUDIO_BYTES) throw new Error("Speech result exceeds 16 MiB.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async named(name: string): Promise<Artifact> {
    return decode(
      Artifact,
      await (await this.request(`/v1/names/${decode(ArtifactName, name)}`)).json(),
    );
  }

  async list(signal?: AbortSignal): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    let next: string | null = null;
    do {
      const response = await this.request(
        `/v1/artifacts${next ? `?after=${encodeURIComponent(next)}` : ""}`,
        { signal },
      );
      const page = decode(ArtifactPage, await response.json());
      artifacts.push(...page.items);
      if (page.next && page.next === next) throw new Error("Scope returned a repeated page.");
      next = page.next;
    } while (next);
    return artifacts;
  }

  async get(id: string, signal?: AbortSignal): Promise<Artifact> {
    const response = await this.request(`/v1/artifacts/${decode(ArtifactId, id)}`, { signal });
    return decode(Artifact, await response.json());
  }

  async updateBase(key: string): Promise<Artifact> {
    const read = async (path: string) =>
      decode(
        Artifact,
        await (await this.request(path, { headers: { [UPDATE_BASE_HEADER]: "1" } })).json(),
      );
    try {
      return await read(`/v1/artifacts/${decode(ArtifactId, key)}`);
    } catch (error) {
      if (!(error instanceof ScopeError) || ![404, 503].includes(error.status)) throw error;
      try {
        decode(ArtifactName, key);
      } catch {
        throw error;
      }
      return read(`/v1/names/${key}`);
    }
  }

  async delete(id: string): Promise<DeleteReceipt> {
    const response = await this.request(`/v1/artifacts/${decode(ArtifactId, id)}`, {
      method: "DELETE",
    });
    return decode(DeleteReceipt, await response.json());
  }

  async memory(): Promise<MemoryStatus> {
    return decode(
      MemoryStatus,
      await readRemoteJson(await this.request("/v1/memory"), MAX_MEMORY_STATUS_BYTES),
    );
  }
  async connectMemory(repository: string): Promise<MemoryStatus> {
    return decode(
      MemoryStatus,
      await readRemoteJson(
        await this.request("/v1/memory/connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(decode(MemoryConnectRequest, { repository })),
        }),
        MAX_MEMORY_STATUS_BYTES,
      ),
    );
  }
  async hubMemory(): Promise<MemoryMachineStatus> {
    return decode(
      MemoryMachineStatus,
      await readRemoteJson(await this.request("/v1/hub/memory"), MAX_MEMORY_STATUS_BYTES),
    );
  }
  async hubQueue(): Promise<HubQueue> {
    return decode(HubQueue, await readRemoteJson(await this.request("/v1/hub/queue"), 128 * 1024));
  }

  async discardQueuedPublication(id: string): Promise<DeleteReceipt> {
    const response = await this.request(`/v1/hub/queue/${decode(ArtifactId, id)}`, {
      method: "DELETE",
    });
    return decode(DeleteReceipt, await response.json());
  }

  async shrink(timeoutMs = MAINTENANCE_TIMEOUT_MS): Promise<ShrinkReceipt> {
    const response = await this.request("/v1/maintenance/shrink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decode(ShrinkRequest, { timeoutMs })),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
    return decode(ShrinkReceipt, await readRemoteJson(response));
  }

  async maintenanceStatus(): Promise<MaintenanceStatus> {
    return decode(
      MaintenanceStatus,
      await readRemoteJson(await this.request("/v1/maintenance/status")),
    );
  }

  async publish(
    id: string,
    metadata: Omit<ArtifactWrite, "blob" | "tabId">,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    return decode(Artifact, await this.publishContent(id, metadata, content, signal, false));
  }

  async publishOrQueue(
    id: string,
    metadata: Omit<ArtifactWrite, "blob" | "tabId">,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PublicationResult> {
    return this.publishContent(id, metadata, content, signal, true);
  }

  private async publishContent(
    id: string,
    metadata: Omit<ArtifactWrite, "blob" | "tabId">,
    content: Uint8Array,
    signal: AbortSignal | undefined,
    buffer: boolean,
  ): Promise<PublicationResult> {
    decode(ArtifactId, id);
    if (content.byteLength > MAX_CONTENT_BYTES)
      throw new Error("Artifact exceeds the 32 MiB limit.");
    const reservation = await this.request(`/v1/artifacts/${id}/tab`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(buffer ? { "Scope-Buffer-Publication": "1" } : {}),
      },
      body: JSON.stringify(
        decode(PublicationRequest, { expectedRevision: metadata.expectedRevision }),
      ),
    });
    const { tabId } = decode(PublicationReceipt, await reservation.json());
    const upload = await this.request(`/v1/tabs/${tabId}/blobs`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(content)]),
    });
    const { blob } = decode(BlobReceipt, await upload.json());
    const response = await this.request(`/v1/artifacts/${id}`, {
      method: "PUT",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decode(ArtifactWrite, { ...metadata, blob, tabId })),
    });
    return decode(PublicationResult, await response.json());
  }

  async content(id: string, revision?: number, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/artifacts/${decode(ArtifactId, id)}/content${revision === undefined ? "" : `?revision=${revision}`}`,
      { signal },
    );
    const size = Number(response.headers.get("content-length"));
    if (size > MAX_CONTENT_BYTES) throw new Error("Artifact exceeds the content limit.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (!response.body) throw new Error("Scope returned no content.");
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_CONTENT_BYTES) throw new Error("Artifact exceeds the content limit.");
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async watch(onEvent: (event: LiveEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await this.request("/v1/events", { signal });
    if (!response.body) throw new Error("Scope returned no event stream.");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value;
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          if (boundary > 64 * 1024) throw new Error("Scope event exceeds the size limit.");
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((item) => item.startsWith("data: "));
          const event = line && decodeLiveEvent(JSON.parse(line.slice(6)));
          if (event) onEvent(event);
        }
        if (pending.length > 64 * 1024) throw new Error("Scope event exceeds the size limit.");
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!signal.aborted) throw new Error("Scope disconnected.");
  }
}
