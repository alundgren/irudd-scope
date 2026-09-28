import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { ArtifactLibrarySnapshot } from "../bridge.ts";

export function useArtifactLibrary(onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<ArtifactLibrarySnapshot>({
    artifacts: [],
    connection: "connecting",
  });
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [arrivals, setArrivals] = useState<Artifact[]>([]);
  const revisions = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    let active = true;
    const receive = (next: ArtifactLibrarySnapshot) => {
      if (!active) return;
      if (next.connection === "connected") {
        const changed = next.artifacts.filter(
          (artifact) => revisions.current?.get(artifact.id) !== artifact.revision,
        );
        if (changed.length) queueArrivals(changed);
        if (changed.length)
          setUnread(
            (previous) => new Set([...previous, ...changed.map((artifact) => artifact.id)]),
          );
      }
      if (next.connection === "connected")
        revisions.current = new Map(
          next.artifacts.map((artifact) => [artifact.id, artifact.revision]),
        );
      if (next.connection === "connected") {
        const ids = new Set(next.artifacts.map((artifact) => artifact.id));
        setUnread((previous) => new Set([...previous].filter((id) => ids.has(id))));
        setArrivals((previous) => previous.filter((artifact) => ids.has(artifact.id)));
      }
      setSnapshot(next);
    };
    let received = false;
    const unsubscribe = window.scope.onArtifactLibraryChange((next) => {
      received = true;
      receive(next);
    });
    void window.scope
      .artifactLibrary()
      .then((next) => {
        if (!received) receive(next);
      })
      .catch(() => {
        if (active) onError("Could not read the artifact library.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [onError]);

  function markRead(id: string): void {
    setUnread((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }

  function recordPublication(artifact: Artifact): void {
    acknowledgeArrivals([artifact]);
    markRead(artifact.id);
  }

  function queueArrivals(artifacts: readonly Artifact[]): void {
    setArrivals((previous) => {
      const pending = new Map(previous.map((artifact) => [artifact.id, artifact]));
      let changed = false;
      for (const artifact of artifacts) {
        if (pending.get(artifact.id)?.revision === artifact.revision) continue;
        pending.set(artifact.id, artifact);
        changed = true;
      }
      return changed ? [...pending.values()] : previous;
    });
  }

  function acknowledgeArrivals(handled: readonly Artifact[]): void {
    setArrivals((previous) =>
      previous.filter(
        (artifact) =>
          !handled.some((item) => item.id === artifact.id && item.revision === artifact.revision),
      ),
    );
  }

  return {
    snapshot,
    unread,
    arrivals,
    queueArrivals,
    acknowledgeArrivals,
    markRead,
    recordPublication,
  };
}
