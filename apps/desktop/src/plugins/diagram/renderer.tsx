import { lazy } from "react";
import type { TabPlugin } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { publishedArtifactId, publishedTabState } from "../../library/tab-state.ts";

const DiagramView = lazy(() =>
  import("./view.tsx").then((module) => ({ default: module.DiagramView })),
);

export const diagramPlugin: TabPlugin = {
  type: "diagram",
  publication: {
    accepts: (artifact) => artifact.kind === "excalidraw",
    artifactId: publishedArtifactId,
    state: publishedTabState,
  },
  View: ({ artifact, context, theme, viewing, active }) => (
    <PublishedContent artifact={artifact}>
      {(item) => (
        <DiagramView
          item={item}
          context={context}
          theme={theme}
          viewing={viewing}
          active={active}
        />
      )}
    </PublishedContent>
  ),
};
