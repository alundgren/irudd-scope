import {
  Artifact,
  ArtifactId,
  ArtifactPage,
  ArtifactWrite,
  BlobReceipt,
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

  async list(): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    let next: string | null = null;
    do {
      const response = await this.request(
        `/v1/artifacts${next ? `?after=${encodeURIComponent(next)}` : ""}`,
      );
      const page = decode(ArtifactPage, await response.json());
      artifacts.push(...page.items);
      if (page.next && page.next === next) throw new Error("Scope returned a repeated page.");
      next = page.next;
    } while (next);
    return artifacts;
  }

  async get(id: string): Promise<Artifact> {
    const response = await this.request(`/v1/artifacts/${decode(ArtifactId, id)}`);
    return decode(Artifact, await response.json());
  }

  async publish(
    id: string,
    metadata: Omit<ArtifactWrite, "blob">,
    content: Uint8Array,
  ): Promise<Artifact> {
    decode(ArtifactId, id);
    if (content.byteLength > MAX_CONTENT_BYTES)
      throw new Error("Artifact exceeds the 32 MiB limit.");
    const upload = await this.request("/v1/blobs", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(content)]),
    });
    const { blob } = decode(BlobReceipt, await upload.json());
    const response = await this.request(`/v1/artifacts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decode(ArtifactWrite, { ...metadata, blob })),
    });
    return decode(Artifact, await response.json());
  }

  async content(id: string, revision?: number): Promise<Uint8Array> {
    const response = await this.request(
      `/v1/artifacts/${decode(ArtifactId, id)}/content${revision === undefined ? "" : `?revision=${revision}`}`,
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
