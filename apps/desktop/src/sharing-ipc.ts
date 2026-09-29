import { dialog, type BrowserWindow } from "electron";
import { Schema } from "effect";
import { decode } from "@irudd-scope/protocol";
import { SharingId } from "@irudd-scope/protocol/sharing";
import { DiagramReply } from "@irudd-scope/protocol/diagram";
import type { diagramCommands } from "./plugins/diagram/command-main.ts";
import type { DesktopLifecycle } from "./lifecycle.ts";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import type { ArtifactLibrary } from "./library/library.ts";
import { activeShare } from "./sharing-contract.ts";
import type { SharedSnapshot, Sharing } from "./sharing.ts";
import { snapshotContent } from "./sharing-export.ts";

export function sharingIpc(
  handle: (channel: string, action: (input: unknown) => unknown) => void,
  sharing: Sharing,
  window: BrowserWindow,
  lifecycle: DesktopLifecycle,
  client: ScopeClient,
  library: ArtifactLibrary,
  diagrams: ReturnType<typeof diagramCommands>,
) {
  let preparing = false;
  handle("scope:sharing", () => sharing.snapshot());
  handle("scope:pair-sharing", (input) =>
    sharing.pair(decode(Schema.String.check(Schema.isMaxLength(4096)), input)),
  );
  handle("scope:sharing-status", (input) => sharing.refreshStatus(decode(SharingId, input)));
  handle("scope:remove-sharing", (input) => sharing.remove(decode(SharingId, input)));
  handle("scope:stop-share", (input) => {
    const { destinationId, shareId } = decode(
      Schema.Struct({ destinationId: SharingId, shareId: SharingId }),
      input,
    );
    return sharing.stop(destinationId, shareId);
  });
  handle("scope:share-tab", async (input) => {
    if (preparing) throw new Error("Finish the current sharing confirmation first.");
    const { destinationId, tabId, refreshId } = decode(
      Schema.Struct({
        destinationId: SharingId,
        tabId: SharingId,
        refreshId: Schema.optionalKey(SharingId),
      }),
      input,
    );
    const destination = sharing.snapshot().find((entry) => entry.id === destinationId);
    if (!destination || destination.removing)
      throw new Error("Pair a sharing service in Settings first.");
    const previous = destination.shares.find(
      (share) => share.tabId === tabId && activeShare(share),
    );
    if (previous && !refreshId) return previous;
    if (refreshId && (!previous || refreshId !== previous.id))
      throw new Error("This share has ended.");
    preparing = true;
    try {
      const tab = (await lifecycle.workspace())?.tabs.find((item) => item.id === tabId);
      const artifactId = tab?.state.data.artifactId;
      if (!tab || typeof artifactId !== "string") throw new Error("The tab is no longer open.");
      const artifact = await client.get(artifactId);
      let snapshot: SharedSnapshot;
      if (tab.type === "diagram") {
        const preview = decode(
          DiagramReply,
          await diagrams.run({ action: "preview", id: artifactId }, AbortSignal.timeout(20_000)),
        );
        if (preview.type !== "preview") throw new Error("Could not export the diagram.");
        snapshot = { tabId, title: artifact.title, mediaType: "image/png", content: preview.data };
      } else
        snapshot = snapshotContent(tabId, await library.content(artifactId, artifact.revision));
      const result = await dialog.showMessageBox(window, {
        type: "question",
        title: refreshId ? "Refresh shared content" : "Share tab publicly",
        message: refreshId
          ? `Replace the shared copy of “${snapshot.title}”?`
          : `Share “${snapshot.title}” publicly?`,
        detail: `Sharing service: ${destination.name}\n${destination.endpoint}\n\nAnyone with the link can read and save this frozen copy. ${refreshId ? `The URL stays the same and still expires at ${new Date(previous!.expiresAt).toLocaleString()}. Viewers reload to see changes.` : "The link ends within 24 hours and may stop sooner. Closing the tab does not stop it."}`,
        buttons: ["Cancel", refreshId ? "Refresh shared content" : "Share publicly"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return null;
      return sharing.write(destinationId, snapshot, refreshId);
    } finally {
      preparing = false;
    }
  });
}
