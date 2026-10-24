import type { OwnerContent } from "../plugins/api.ts";
import { useEffect, useState, useRef, type ReactNode } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import type { ArtifactContent } from "../bridge.ts";
import { Button } from "../renderer/components/ui/button.tsx";

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
  const [retry, setRetry] = useState(0);
  const loaded = useRef<ArtifactContent | undefined>(undefined);
  const owner = content ? `${content.ownerDeviceId}/${content.sourceTabId}` : undefined;
  const loadedOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!artifact || content?.available === false) return;
    if (
      content &&
      loadedOwner.current === owner &&
      loaded.current?.artifact.id === artifact.id &&
      loaded.current.artifact.revision === artifact.revision &&
      loaded.current.artifact.blob === artifact.blob
    )
      return;
    let active = true;
    setItem((previous) =>
      !content && previous?.artifact.id === artifact.id ? previous : undefined,
    );
    setError("");
    void (content ? content.read(artifact) : window.scope.content(artifact.id, artifact.revision))
      .then((content) => {
        if (active) {
          loaded.current = content;
          loadedOwner.current = owner;
          setItem(content);
        }
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
              : "Could not load the artifact.",
          );
      });
    return () => {
      active = false;
    };
  }, [artifact?.id, artifact?.revision, artifact?.blob, content, owner, retry]);
  // Reject an old document during render, before the replacement effect runs.
  const current =
    !content ||
    (loadedOwner.current === owner &&
      item?.artifact.id === artifact?.id &&
      item?.artifact.revision === artifact?.revision &&
      item?.artifact.blob === artifact?.blob);
  if (!current && item)
    return (
      <p className="empty-state" role="status">
        Loading current artifact…
      </p>
    );
  if (error && !item)
    return (
      <div className="empty-state" role="alert">
        <p>{error}</p>
        {content && (
          <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>
            Retry content
          </Button>
        )}
      </div>
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
