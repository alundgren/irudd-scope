import { useEffect, useRef, useState } from "react";
import type { PlanCommand, PlanSnapshot } from "@irudd-scope/protocol/plan";
import { readPlanSnapshot } from "@irudd-scope/protocol/plan";
import { MessageSquare, Pin } from "lucide-react";
import type { TabProps } from "../api.ts";
import type { PlanDraft } from "./draft.ts";
import { CommentCapture, markedScreenshot } from "./annotation.tsx";
import { PlanReview } from "./review.tsx";
import { FeedbackActions } from "./feedback-actions.tsx";
import { useDocumentScroll } from "./document-scroll.ts";
import { PendingMarks, readDocumentViewport } from "./pending-marks.tsx";
import { Button } from "../../renderer/components/ui/button.tsx";
import { useAutosave } from "../../workspace/persistence.ts";

const message = (failure: unknown) =>
  failure instanceof Error ? failure.message : "Could not update the plan.";
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

export function PlanView({ artifact, tab, context, focus, active }: TabProps) {
  const name = artifact?.name;
  const [snapshot, setSnapshot] = useState<PlanSnapshot>();
  const [reviewOpen, setReviewOpen] = useState(tab.state.data.reviewOpen === true);
  const [revision, setRevision] = useState(
    typeof tab.state.data.revision === "number"
      ? tab.state.data.revision
      : (artifact?.revision ?? 1),
  );
  const [content, setContent] = useState<{ html: string; revision: number }>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const iframe = useRef<HTMLIFrameElement>(null);
  const observeDocument = useDocumentScroll(iframe, active, content?.revision);
  const savedDraft = useRef<PlanDraft | null | undefined>(undefined);
  const refreshNumber = useRef(0);
  const tabState = useRef(tab.state);
  tabState.current = tab.state;
  const persistence = useAutosave(
    () => savedDraft.current,
    (value) => window.scope.savePlanDraft({ tabId: tab.id, draft: value }),
    tab.id,
  );
  function changeDraft(value: PlanDraft | null) {
    savedDraft.current = value;
    setDraft(value);
    persistence.schedule();
  }
  function showReview(value: boolean) {
    setReviewOpen(value);
    context.updateState({
      version: 1,
      data: { ...tabState.current.data, reviewOpen: value, revision },
    });
    if (value) void refresh();
  }
  function selectRevision(value: number) {
    if (captureOpen) return;
    setRevision(value);
    context.updateState({
      version: 1,
      data: { ...tabState.current.data, reviewOpen, revision: value },
    });
  }
  async function refresh() {
    if (!name) return;
    const read = ++refreshNumber.current;
    try {
      const incoming = await readPlanSnapshot(window.scope.planCommand, name);
      if (read === refreshNumber.current) setSnapshot(incoming);
    } catch (failure) {
      if (read === refreshNumber.current) setError(message(failure));
    }
  }
  useEffect(() => {
    void refresh();
    return window.scope.onPlanChanged((event) => {
      if (event.name === name) void refresh();
    });
  }, [name, artifact?.revision]);
  useEffect(() => window.scope.onPlanReconnected(() => void refresh()), [name]);
  useEffect(() => {
    let mounted = true;
    void window.scope
      .loadPlanDraft(tab.id)
      .then((value) => {
        if (mounted && savedDraft.current === undefined) {
          savedDraft.current = value;
          setDraft(value);
        }
        if (mounted) setDraftLoaded(true);
      })
      .catch((failure: unknown) => {
        if (mounted) setError(message(failure));
      });
    return () => {
      mounted = false;
    };
  }, [tab.id, retry]);
  useEffect(() => {
    if (!name) return;
    let mounted = true;
    setLoading(true);
    void window.scope
      .planContent({ name, revision })
      .then((bytes) => {
        if (mounted) {
          setContent({ html: new TextDecoder().decode(bytes), revision });
          setLoading(false);
        }
      })
      .catch((failure: unknown) => {
        if (mounted) {
          setError(message(failure));
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [name, revision, retry]);
  async function command(value: PlanCommand): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      const reply = await window.scope.planCommand(value);
      if (reply.type === "receipt" && value.action === "restore")
        selectRevision(reply.artifact.revision);
      await refresh();
      return true;
    } catch (failure) {
      setError(`${message(failure)} Refresh the review and retry. Your draft is retained.`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function capture() {
    if (draft) {
      setCaptureOpen(true);
      return;
    }
    if (!iframe.current || loading || content?.revision !== revision) return;
    setError("");
    setCapturing(true);
    showReview(false);
    try {
      await nextFrame();
      const bounds = iframe.current.getBoundingClientRect();
      const viewport = readDocumentViewport(iframe.current);
      const result = await window.scope.capturePlan({
        tabId: tab.id,
        revision,
        rect: {
          x: Math.floor(bounds.x),
          y: Math.floor(bounds.y),
          width: Math.min(Math.ceil(bounds.width), window.innerWidth - Math.floor(bounds.x)),
          height: Math.min(Math.ceil(bounds.height), window.innerHeight - Math.floor(bounds.y)),
        },
      });
      if (
        viewport &&
        JSON.stringify(readDocumentViewport(iframe.current)) !== JSON.stringify(viewport)
      )
        throw new Error("The page moved while taking the screenshot. Try again.");
      let page = "",
        selectedText = "",
        elementId = "";
      try {
        const document = iframe.current.contentDocument;
        page = document?.title.slice(0, 512) ?? "";
        selectedText = document?.getSelection()?.toString().slice(0, 512) ?? "";
        elementId = document?.activeElement?.id.slice(0, 512) ?? "";
      } catch {
        /* An authored page may navigate to another origin. */
      }
      changeDraft({
        revision,
        ...result,
        text: "",
        page,
        annotations: [{ type: "pin", at: { x: 0.25, y: 0.25 } }],
        ...(viewport && { viewport }),
        requestId: crypto.randomUUID(),
        ...(selectedText && { selectedText }),
        ...(elementId && { elementId }),
      });
      setCaptureOpen(true);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setCapturing(false);
    }
  }
  async function addComment() {
    if (!draft || !name) return;
    setBusy(true);
    setError("");
    try {
      const annotatedImage = await markedScreenshot(draft);
      if (
        await command({
          action: "comment",
          name,
          requestId: draft.requestId,
          revision: draft.revision,
          image: draft.image,
          annotatedImage,
          annotations: draft.annotations,
          ...(draft.viewport && { viewport: draft.viewport }),
          text: draft.text.trim(),
          page: draft.page,
          ...(draft.selectedText && { selectedText: draft.selectedText }),
          ...(draft.elementId && { elementId: draft.elementId }),
        })
      ) {
        changeDraft(null);
        await persistence.flush();
        setCaptureOpen(false);
        showReview(false);
      }
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="plan-view" data-focus={focus}>
      <div className="plan-page">
        <iframe
          key={content?.revision}
          ref={iframe}
          className="plan-document"
          title={artifact?.title ?? "Plan"}
          srcDoc={content?.html}
          onLoad={observeDocument}
        />
        {!capturing && !loading && content?.revision === revision && (
          <PendingMarks
            iframe={iframe}
            snapshot={snapshot}
            revision={revision}
            draft={draft}
            command={command}
            busy={busy}
            onResume={() => setCaptureOpen(true)}
          />
        )}
        {loading && (
          <p className="plan-notice" role="status">
            Loading version {revision}…
          </p>
        )}
        {reviewOpen && !focus && snapshot && (
          <PlanReview
            snapshot={snapshot}
            revision={revision}
            onRevision={selectRevision}
            onClose={() => showReview(false)}
            command={command}
            busy={busy}
          />
        )}
      </div>
      {!focus && (
        <div
          className="plan-controls"
          style={{ display: capturing || captureOpen ? "none" : undefined }}
        >
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={draft ? "Resume comment" : "Comment"}
            title={draft ? "Resume comment" : "Pin a comment"}
            disabled={loading || busy || !draftLoaded}
            onClick={() => void capture()}
          >
            <Pin />
          </Button>
          {snapshot && (
            <FeedbackActions
              snapshot={snapshot}
              revision={revision}
              command={command}
              busy={busy}
            />
          )}
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={
              snapshot?.responses.some((response) => !response.seen) ? "Feedback · new" : "Feedback"
            }
            title="Feedback and versions"
            aria-expanded={reviewOpen && !focus}
            onClick={() => showReview(!reviewOpen)}
          >
            <MessageSquare />
          </Button>
        </div>
      )}
      {captureOpen && draft && active && !focus && (
        <CommentCapture
          draft={draft}
          onChange={changeDraft}
          onSave={() => void addComment()}
          onCancel={() => setCaptureOpen(false)}
          onDiscard={() => {
            changeDraft(null);
            setCaptureOpen(false);
          }}
          busy={busy}
        />
      )}
      {(error || persistence.error) && (
        <div className="plan-notice plan-error" role="alert">
          <span>{error || "Could not save the comment draft."}</span>
          <Button
            variant="outline"
            onClick={() => {
              setError("");
              void refresh();
              if (persistence.error)
                void persistence.flush().catch((failure: unknown) => setError(message(failure)));
              setRetry(retry + 1);
            }}
          >
            Refresh and retry
          </Button>
        </div>
      )}
    </div>
  );
}
