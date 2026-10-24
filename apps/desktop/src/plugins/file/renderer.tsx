import type { Artifact } from "@irudd-scope/protocol";
import type { TabPlugin } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { publishedArtifactId, publishedTabState } from "../../library/tab-state.ts";
import { FileViews } from "../../renderer/file-views.tsx";

function FileView({ artifact }: { artifact: Artifact }) {
  return (
    <div className="file-preview">
      <h1>{artifact.fileName}</h1>
      <p>{(artifact.size / 1024).toFixed(1)} KiB</p>
      <p>Use Download to save this file.</p>
    </div>
  );
}

export const filePlugin: TabPlugin = {
  type: "file",
  publication: { accepts: () => true, artifactId: publishedArtifactId, state: publishedTabState },
  View: ({ artifact }) =>
    artifact?.kind === "file" ? (
      <FileView artifact={artifact} />
    ) : (
      <PublishedContent artifact={artifact}>
        {(item) => (
          <FileViews
            content={{
              bytes: item.bytes,
              kind: item.artifact.kind,
              mediaType: item.artifact.mediaType,
              title: item.artifact.title,
              version: item.artifact.blob,
            }}
            fallback={<FileView artifact={item.artifact} />}
          />
        )}
      </PublishedContent>
    ),
};
