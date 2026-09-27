import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { publishedArtifactId, publishedTabState } from "../../library/tab-state.ts";

const DiagramView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.DiagramView })),
);
const CreateDiagram = lazy(() =>
  import("./create.tsx").then((module) => ({ default: module.CreateDiagram })),
);

export const diagramPlugin: TabPlugin = {
  type: "diagram",
  publication: {
    accepts: (artifact) => artifact.kind === "excalidraw",
    artifactId: publishedArtifactId,
    state: publishedTabState,
  },
  View: ({ artifact, context, theme, focus }) => (
    <PublishedContent artifact={artifact}>
      {(item) => <DiagramView item={item} context={context} theme={theme} focus={focus} />}
    </PublishedContent>
  ),
  tools: [
    {
      id: "create-diagram",
      title: "Create diagram",
      keywords: "create diagram drawing",
      View: ({ onCreated, onClose }) => (
        <CreateDiagram
          onClose={onClose}
          onCreated={(artifact) =>
            onCreated({
              type: "diagram",
              title: artifact.title,
              state: publishedTabState(artifact),
              artifact,
            })
          }
        />
      ),
    },
  ],
};
