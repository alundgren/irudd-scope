import type { TabPlugin } from "../api.ts";
import { PublishedContent } from "../../library/content-view.tsx";
import { publishedArtifactId, publishedTabState } from "../../library/tab-state.ts";
import { FileView, FileViews } from "./views.tsx";

export const filePlugin: TabPlugin = {
  type: "file",
  publication: { accepts: () => true, artifactId: publishedArtifactId, state: publishedTabState },
  View: ({ artifact, theme, focus }) =>
    artifact?.kind === "file" ? (
      <FileView artifact={artifact} />
    ) : (
      <PublishedContent artifact={artifact}>
        {(item) => <FileViews item={item} theme={theme} focus={focus} />}
      </PublishedContent>
    ),
};
