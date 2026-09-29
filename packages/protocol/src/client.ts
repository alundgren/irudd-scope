import {
  VoiceRequest,
  VoiceRequestId,
  VoiceReceipt,
  MAX_VOICE_AUDIO_BYTES,
  MAX_VOICE_REQUEST_BYTES,
} from "./voice.ts";
import { DiagramAgentCommand, DiagramAgentReply } from "./diagram-agent.ts";
import { DiagramSyncCommand, DiagramSyncReply } from "./diagram-sync.ts";
import {
  DiagramCommand,
  DiagramReply,
  MAX_DIAGRAM_REPLY_BYTES,
  MAX_DIAGRAM_REQUEST_BYTES,
} from "./diagram.ts";
import { readRemoteJson } from "./remote.ts";
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
  ArtifactPage,
  ArtifactWrite,
  BlobReceipt,
  DeleteReceipt,
  PublicationReceipt,
  PublicationRequest,
  LiveEvent,
  MAX_CONTENT_BYTES,
  ScopeError,
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
        `Cannot reach Scope at ${this.endpoint}. Open Scope on the Mac and retry. Requests are not queued.`,
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

  async diagramAgent(input: DiagramAgentCommand): Promise<DiagramAgentReply> {
    const body = JSON.stringify(decode(DiagramAgentCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_DIAGRAM_REQUEST_BYTES)
      throw new Error("Agent request exceeds 512 KiB.");
    return decode(
      DiagramAgentReply,
      await readRemoteJson(
        await this.request("/v1/diagram-agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_DIAGRAM_REPLY_BYTES,
      ),
    );
  }

  async diagram(input: DiagramCommand): Promise<DiagramReply> {
    const body = JSON.stringify(decode(DiagramCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_DIAGRAM_REQUEST_BYTES)
      throw new Error("Diagram request exceeds 512 KiB.");
    return decode(
      DiagramReply,
      await readRemoteJson(
        await this.request("/v1/diagrams", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_DIAGRAM_REPLY_BYTES,
      ),
    );
  }

  async syncDiagram(input: DiagramSyncCommand): Promise<DiagramSyncReply> {
    const body = JSON.stringify(decode(DiagramSyncCommand, input));
    if (new TextEncoder().encode(body).byteLength > MAX_CONTENT_BYTES)
      throw new Error("Diagram request exceeds 32 MiB.");
    return decode(
      DiagramSyncReply,
      await readRemoteJson(
        await this.request("/v1/diagrams/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
        MAX_CONTENT_BYTES + 64 * 1024,
      ),
    );
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

  async delete(id: string): Promise<DeleteReceipt> {
    const response = await this.request(`/v1/artifacts/${decode(ArtifactId, id)}`, {
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
    decode(ArtifactId, id);
    if (content.byteLength > MAX_CONTENT_BYTES)
      throw new Error("Artifact exceeds the 32 MiB limit.");
    const reservation = await this.request(`/v1/artifacts/${id}/tab`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
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
    return decode(Artifact, await response.json());
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
        if (pending.length > 64 * 1024) throw new Error("Scope event exceeds the size limit.");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((item) => item.startsWith("data: "));
          if (line) onEvent(decode(LiveEvent, JSON.parse(line.slice(6))));
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!signal.aborted) throw new Error("Scope disconnected.");
  }
}
