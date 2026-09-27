import { useEffect, useState, type ReactNode } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../bridge.ts";

export function PublishedContent({
  artifact,
  children,
}: {
  artifact?: Artifact;
  children: (item: ArtifactContent) => ReactNode;
}) {
  const [item, setItem] = useState<ArtifactContent>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!artifact) return;
    let active = true;
    setItem((previous) => (previous?.artifact.id === artifact.id ? previous : undefined));
    setError("");
    void window.scope
      .content(artifact.id, artifact.revision)
      .then((content) => {
        if (active) setItem(content);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : "Could not load the artifact.");
      });
    return () => {
      active = false;
    };
  }, [artifact?.id, artifact?.revision]);
  if (error && !item)
    return (
      <p className="empty-state" role="alert">
        {error}
      </p>
    );
  if (!item)
    return (
      <p className="empty-state" role="status">
        Loading artifact…
      </p>
    );
  return (
    <>
      {error && (
        <p className="diagram-notice" role="alert">
          {error} Showing the last loaded version.
        </p>
      )}
      {children(item)}
    </>
  );
}
