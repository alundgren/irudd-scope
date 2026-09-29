import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { DiagramProposal } from "@irudd-scope/protocol/diagram-sync";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DiagramViewport } from "./draft.ts";
import type { Theme } from "../../renderer/appearance.ts";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useDiagramViewport } from "./viewport.ts";
import { useDiagramMenu } from "./native-menu.ts";

export function ProposalPreview({
  proposal,
  theme,
  viewing,
  onEdit,
  onAccept,
  onReject,
  onDiscuss,
  viewport,
  onViewportChange,
  active,
  tabId,
  saving,
  onSaveCopy,
}: {
  proposal: DiagramProposal;
  theme: Theme;
  viewing: boolean;
  onEdit: (content: string) => void;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
  onDiscuss: () => void;
  viewport?: DiagramViewport;
  onViewportChange: (viewport: DiagramViewport) => void;
  active: boolean;
  tabId: string;
  saving: boolean;
  onSaveCopy: (content: string) => Promise<void>;
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const [ready, setReady] = useState(false);
  const canvasViewport = useDiagramViewport(api, active, ready, viewport);
  const initial = useMemo(
    () =>
      loadFromBlob(new Blob([proposal.content]), null, null).then((data) => ({
        ...data,
        scrollToContent: false,
        appState: {
          ...data.appState,
          ...(viewport
            ? {
                scrollX: viewport.scrollX,
                scrollY: viewport.scrollY,
                zoom: { value: viewport.zoom } as AppState["zoom"],
              }
            : {}),
        },
      })),
    [proposal.id],
  );
  const latest = useRef(proposal.content);
  const [busy, setBusy] = useState(false);
  useDiagramMenu({
    tabId,
    api,
    active,
    ready,
    busy: busy || saving,
    saveCopy: async () => {
      if (api)
        await onSaveCopy(
          serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), "local"),
        );
    },
  });
  const [error, setError] = useState("");
  const accept = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (accept.current?.getClientRects().length) accept.current.focus({ preventScroll: true });
  }, [proposal.id]);
  async function decide(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save your decision.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="diagram-proposal" aria-label="Proposed diagram">
      <div className="diagram-notice">
        <span>
          <strong>Proposed change</strong> · {proposal.note || "Is this what you meant?"} You can
          edit this preview before accepting.
        </span>
        <Button size="sm" variant="secondary" onClick={onDiscuss}>
          Discuss with agent
        </Button>
        <Button ref={accept} size="sm" disabled={busy} onClick={() => void decide(onAccept)}>
          Accept proposal
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(onReject)}>
          Reject proposal
        </Button>
      </div>
      {error && (
        <div className="diagram-notice" role="alert">
          {error}
        </div>
      )}
      <div className="diagram-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initial}
          theme={theme}
          viewModeEnabled={viewing}
          zenModeEnabled={viewing}
          aiEnabled={false}
          validateEmbeddable={false}
          onLinkOpen={(_element, event) => event.preventDefault()}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              export: false,
            },
          }}
          onChange={(elements, state, files) => {
            if (state.isLoading) return;
            setReady(true);
            canvasViewport.observe(state);
            const savedViewport = canvasViewport.read();
            if (savedViewport) onViewportChange(savedViewport);
            const content = serializeAsJSON(elements, state, files, "local");
            if (content !== latest.current) {
              latest.current = content;
              onEdit(content);
            }
          }}
        />
      </div>
    </section>
  );
}
