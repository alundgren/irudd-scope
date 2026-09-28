import { useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, loadFromBlob, serializeAsJSON } from "@excalidraw/excalidraw";
import type { DiagramProposal } from "@irudd-scope/protocol/diagram-sync";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DiagramDraft } from "./draft.ts";
import type { Theme } from "../../renderer/appearance.ts";
import { Button } from "../../renderer/components/ui/button.tsx";

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
}: {
  proposal: DiagramProposal;
  theme: Theme;
  viewing: boolean;
  onEdit: (content: string) => void;
  onAccept: () => Promise<void>;
  onReject: () => Promise<void>;
  onDiscuss: () => void;
  viewport?: DiagramDraft["viewport"];
  onViewportChange: (viewport: DiagramDraft["viewport"]) => void;
}) {
  const api = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const fitted = useRef(Boolean(viewport));
  const initial = useMemo(
    () =>
      loadFromBlob(new Blob([proposal.content]), null, null).then((data) => ({
        ...data,
        scrollToContent: !viewport,
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
          excalidrawAPI={(value) => {
            api.current = value;
          }}
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
            if (!fitted.current) {
              if (!api.current || !state.width || !state.height) return;
              fitted.current = true;
              if (elements.length) {
                api.current.scrollToContent(elements, { fitToContent: true, animate: false });
                return;
              }
            }
            onViewportChange({
              zoom: state.zoom.value,
              scrollX: state.scrollX,
              scrollY: state.scrollY,
            });
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
