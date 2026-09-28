import {
  combineDiagramDeltas,
  diagramDelta,
  emptyDelta,
  parseNativeDiagram,
  type DiagramDelta,
  type NativeDiagram,
} from "@irudd-scope/protocol/diagram-sync";

type Snapshot = { version: string; document: NativeDiagram; content: string };

export class DiagramHistory {
  private current?: Snapshot;
  private entries: { from: string; to: string; delta: DiagramDelta; bytes: number }[] = [];
  private bytes = 0;

  async capture(content: string, tabId: string): Promise<Snapshot> {
    if (this.current?.content === content) return this.current;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${tabId}\n${content}`),
    );
    const version = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    if (this.current?.version === version) return this.current;
    const document = parseNativeDiagram(JSON.parse(content));
    if (this.current) {
      const delta = diagramDelta(this.current.document, document);
      const bytes = new TextEncoder().encode(JSON.stringify(delta)).byteLength;
      this.entries.push({ from: this.current.version, to: version, delta, bytes });
      this.bytes += bytes;
      while (this.entries.length > 128 || this.bytes > 2 * 1024 * 1024) {
        this.bytes -= this.entries.shift()!.bytes;
      }
    }
    this.current = { version, document, content };
    return this.current;
  }

  since(version: string): DiagramDelta | undefined {
    if (this.current?.version === version) return emptyDelta();
    const index = this.entries.findLastIndex((entry) => entry.from === version);
    if (index < 0) return undefined;
    return combineDiagramDeltas(this.entries.slice(index).map((entry) => entry.delta));
  }
}
