import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { ArtifactLibrarySnapshot } from "../bridge.ts";

export function useArtifactLibrary(onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<ArtifactLibrarySnapshot>({
    artifacts: [],
    connection: "connecting",
  });
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [arrivals, setArrivals] = useState<string[]>([]);
  const revisions = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    let active = true;
    const receive = (next: ArtifactLibrarySnapshot) => {
      if (!active) return;
      if (revisions.current) {
        const added = next.artifacts.filter((artifact) => !revisions.current!.has(artifact.id));
        if (added.length)
          setArrivals((previous) => [
            ...new Set([...previous, ...added.map((artifact) => artifact.id)]),
          ]);
        const changed = next.artifacts.filter(
          (artifact) => revisions.current!.get(artifact.id) !== artifact.revision,
        );
        if (changed.length)
          setUnread(
            (previous) => new Set([...previous, ...changed.map((artifact) => artifact.id)]),
          );
      }
      if (next.connection === "connected")
        revisions.current = new Map(
          next.artifacts.map((artifact) => [artifact.id, artifact.revision]),
        );
      setSnapshot(next);
    };
    const unsubscribe = window.scope.onArtifactLibraryChange(receive);
    void window.scope
      .artifactLibrary()
      .then(receive)
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
    revisions.current?.set(artifact.id, artifact.revision);
    acknowledgeArrivals([artifact.id]);
    setSnapshot((previous) => ({
      ...previous,
      artifacts: [...previous.artifacts.filter((entry) => entry.id !== artifact.id), artifact],
    }));
  }

  function acknowledgeArrivals(ids: readonly string[]): void {
    setArrivals((previous) => previous.filter((id) => !ids.includes(id)));
  }

  return { snapshot, unread, arrivals, acknowledgeArrivals, markRead, recordPublication };
}
