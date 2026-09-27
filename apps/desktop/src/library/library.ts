import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { ArtifactContent, ArtifactLibrarySnapshot } from "../bridge.ts";

export class ArtifactLibrary {
  private current: ArtifactLibrarySnapshot = { artifacts: [], connection: "connecting" };
  private connection?: AbortController;
  private cache = new Map<string, ArtifactContent>();

  constructor(
    private readonly client: ScopeClient,
    private readonly onChange: (snapshot: ArtifactLibrarySnapshot) => void,
  ) {}

  snapshot(): ArtifactLibrarySnapshot {
    return this.current;
  }

  async content(id: string, revision: number): Promise<ArtifactContent> {
    const key = `${id}@${revision}`;
    const existing = this.cache.get(key);
    if (existing) return existing;
    const artifact = await this.client.get(id);
    if (artifact.revision !== revision)
      throw new Error("This artifact changed. Open the latest version.");
    const result = { artifact, bytes: await this.client.content(id, revision) };
    this.cache.set(key, result);
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  private update(snapshot: ArtifactLibrarySnapshot): void {
    this.current = snapshot;
    this.onChange(snapshot);
  }

  async connect(): Promise<void> {
    this.connection?.abort();
    const active = new AbortController();
    this.connection = active;
    this.update({ ...this.current, connection: "connecting", error: undefined });
    let delay = 1000;
    while (!active.signal.aborted) {
      try {
        await this.client.watch((event) => {
          if (active.signal.aborted) return;
          if (event.type === "ready") {
            void this.client
              .list()
              .then((artifacts) => {
                if (active.signal.aborted) return;
                const merged = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
                for (const artifact of this.current.artifacts)
                  if ((merged.get(artifact.id)?.revision ?? 0) < artifact.revision)
                    merged.set(artifact.id, artifact);
                this.update({ artifacts: [...merged.values()], connection: "connected" });
                delay = 1000;
              })
              .catch(() => {
                if (!active.signal.aborted)
                  this.update({
                    ...this.current,
                    connection: "offline",
                    error: "Could not refresh the artifact list.",
                  });
              });
          } else {
            const artifacts = new Map(
              this.current.artifacts.map((artifact) => [artifact.id, artifact]),
            );
            artifacts.set(event.artifact.id, event.artifact);
            this.update({ artifacts: [...artifacts.values()], connection: "connected" });
          }
        }, active.signal);
      } catch (error) {
        if (active.signal.aborted) break;
        this.update({
          ...this.current,
          connection: "offline",
          error:
            error instanceof Error ? error.message : "Cannot connect to local artifact storage.",
        });
      }
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          active.signal.removeEventListener("abort", finish);
          done();
        };
        const timer = setTimeout(finish, delay);
        active.signal.addEventListener("abort", finish, { once: true });
        if (active.signal.aborted) finish();
      });
      delay = Math.min(delay * 2, 10_000);
    }
  }

  close(): void {
    this.connection?.abort();
  }
}
