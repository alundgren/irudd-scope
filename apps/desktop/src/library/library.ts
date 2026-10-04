import type { RetroEvent } from "@irudd-scope/protocol";
import type { Artifact } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { ArtifactContent, ArtifactLibrarySnapshot } from "../bridge.ts";

import type { PlanEvent } from "@irudd-scope/protocol/plan";
import type { PullRequestsEvent } from "@irudd-scope/protocol/pull-requests";

export class ArtifactLibrary {
  private retroListeners = new Set<(event: RetroEvent) => void>();
  private retroReconnectListeners = new Set<() => void>();
  onRetroChanged(listener: (event: RetroEvent) => void) {
    this.retroListeners.add(listener);
    return () => {
      this.retroListeners.delete(listener);
    };
  }
  onRetroReconnected(listener: () => void) {
    this.retroReconnectListeners.add(listener);
    return () => {
      this.retroReconnectListeners.delete(listener);
    };
  }
  private pullRequestsListeners = new Set<(event: PullRequestsEvent) => void>();
  private pullRequestsReconnectListeners = new Set<() => void>();

  onPullRequestsReconnected(listener: () => void): () => void {
    this.pullRequestsReconnectListeners.add(listener);
    return () => {
      this.pullRequestsReconnectListeners.delete(listener);
    };
  }

  onPullRequestsChanged(listener: (event: PullRequestsEvent) => void): () => void {
    this.pullRequestsListeners.add(listener);
    return () => {
      this.pullRequestsListeners.delete(listener);
    };
  }
  private planListeners = new Set<(event: PlanEvent) => void>();
  private planReconnectListeners = new Set<() => void>();

  onPlanReconnected(listener: () => void): () => void {
    this.planReconnectListeners.add(listener);
    return () => {
      this.planReconnectListeners.delete(listener);
    };
  }

  onPlanChanged(listener: (event: PlanEvent) => void): () => void {
    this.planListeners.add(listener);
    return () => {
      this.planListeners.delete(listener);
    };
  }
  private current: ArtifactLibrarySnapshot = { artifacts: [], connection: "connecting" };
  private connection?: AbortController;
  private cache = new Map<string, ArtifactContent>();
  private loads = new Map<AbortController, string>();
  private refresh = 0;

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
    const active = new AbortController();
    this.loads.set(active, id);
    try {
      const artifact = await this.client.get(id, active.signal);
      if (artifact.revision !== revision)
        throw new Error("This artifact changed. Open the latest version.");
      const result = { artifact, bytes: await this.client.content(id, revision, active.signal) };
      active.signal.throwIfAborted();
      this.cache.set(key, result);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
      return result;
    } finally {
      this.loads.delete(active);
    }
  }

  private invalidate(id: string): void {
    for (const [key, value] of this.cache) if (value.artifact.id === id) this.cache.delete(key);
    for (const [active, loading] of this.loads) if (loading === id) active.abort();
  }

  remove(id: string): void {
    this.invalidate(id);
    this.update({
      ...this.current,
      artifacts: this.current.artifacts.filter((item) => item.id !== id),
    });
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
        let changes: Map<string, Artifact | null> | undefined;
        await this.client.watch((event) => {
          if (active.signal.aborted) return;
          if (event.type === "retro") for (const listener of this.retroListeners) listener(event);
          if (event.type === "ready") {
            for (const listener of this.retroReconnectListeners) listener();
            const refresh = ++this.refresh;
            changes = new Map();
            for (const listener of this.planReconnectListeners) {
              try {
                listener();
              } catch {
                console.error("A plan reconnect listener failed.");
              }
            }
            for (const listener of this.pullRequestsReconnectListeners) {
              try {
                listener();
              } catch {
                console.error("A pull request reconnect listener failed.");
              }
            }
            void this.client
              .list(active.signal)
              .then((artifacts) => {
                if (active.signal.aborted || refresh !== this.refresh) return;
                const merged = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
                for (const [id, value] of changes ?? []) {
                  if (value) merged.set(id, value);
                  else merged.delete(id);
                }
                changes = undefined;
                for (const item of this.current.artifacts)
                  if (!merged.has(item.id)) this.invalidate(item.id);
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
          } else if (event.type === "pull-requests") {
            for (const listener of this.pullRequestsListeners) {
              try {
                listener(event);
              } catch {
                console.error("A pull request update listener failed.");
              }
            }
          } else if (event.type === "plan") {
            for (const listener of this.planListeners) {
              try {
                listener(event);
              } catch {
                console.error("A plan update listener failed.");
              }
            }
          } else if (event.type === "deleted") {
            changes?.set(event.id, null);
            this.remove(event.id);
          } else if (event.type === "artifact") {
            changes?.set(event.artifact.id, event.artifact);
            this.invalidate(event.artifact.id);
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
    this.refresh++;
    for (const active of this.loads.keys()) active.abort();
    this.loads.clear();
    this.cache.clear();
    this.planListeners.clear();
    this.planReconnectListeners.clear();
    this.retroListeners.clear();
    this.retroReconnectListeners.clear();
    this.pullRequestsListeners.clear();
    this.pullRequestsReconnectListeners.clear();
  }
}
