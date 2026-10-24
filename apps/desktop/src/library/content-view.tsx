import type { OwnerContent } from "../plugins/api.ts";
import { useEffect, useState, type ReactNode } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../bridge.ts";

export function PublishedContent({
  artifact,
  content,
  children,
}: {
  artifact?: Artifact;
  content?: OwnerContent;
  children: (item: ArtifactContent) => ReactNode;
}) {
  const [item, setItem] = useState<ArtifactContent>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!artifact) return;
    let active = true;
    setItem((previous) =>
      !content && previous?.artifact.id === artifact.id ? previous : undefined,
    );
    setError("");
    void (content ? content.read(artifact) : window.scope.content(artifact.id, artifact.revision))
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
  }, [artifact?.id, artifact?.revision, content]);
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
        <p className="content-notice" role="alert">
          {error} Showing the last loaded version.
        </p>
      )}
      {children(item)}
    </>
  );
}
