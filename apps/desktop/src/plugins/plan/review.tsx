import { useEffect, useState } from "react";
import type { PlanCommand, PlanComment, PlanSnapshot } from "@irudd-scope/protocol/plan";
import { Pin, X } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { CommentThread } from "./comment-thread.tsx";
import { copyAgentRequest } from "./feedback-actions.tsx";

function CommentImage({ name, comment }: { name: string; comment: PlanComment }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let url = "";
    void window.scope
      .planImage({ name, id: comment.image.id })
      .then((bytes) => {
        if (!active) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        setSource(url);
        setError("");
      })
      .catch(() => {
        if (active) setError("Could not load the captured page.");
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [name, comment.image.id, retry]);
  return (
    <>
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button variant="ghost" onClick={() => setRetry(retry + 1)}>
            Retry image
          </Button>
        </p>
      ) : (
        source && (
          <img
            className="plan-comment-image"
            alt={`Annotated page for comment: ${comment.text}`}
            src={source}
          />
        )
      )}
    </>
  );
}

export function PlanReview({
  snapshot,
  revision,
  onRevision,
  onClose,
  command,
  busy,
}: {
  snapshot: PlanSnapshot;
  revision: number;
  onRevision: (revision: number) => void;
  onClose: () => void;
  command: (command: PlanCommand) => Promise<boolean>;
  busy: boolean;
}) {
  const name = snapshot.artifact.name!;
  const [selected, setSelected] = useState<string>();
  const [copiedRound, setCopiedRound] = useState("");
  const [copyError, setCopyError] = useState("");
  const selectedComment = snapshot.comments.find((comment) => comment.id === selected);
  async function copyRequest(roundId: string) {
    setCopyError("");
    setCopiedRound("");
    try {
      await copyAgentRequest(name, roundId);
      setCopiedRound(roundId);
    } catch {
      setCopyError("Could not copy the agent request. Try again.");
    }
  }
  return (
    <>
      <div className="plan-review-heading">
        <h2>Feedback</h2>
        <Button variant="ghost" size="icon" aria-label="Hide feedback" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="plan-review-scroll" data-floating-overlay-content>
        <div className="plan-version-controls">
          <label>
            Version
            <select
              aria-label="Version"
              className="plan-version-select"
              value={revision}
              onChange={(event) => onRevision(Number(event.target.value))}
            >
              {snapshot.revisions.map((entry) => (
                <option key={entry.revision} value={entry.revision}>
                  Version {entry.revision}
                  {entry.revision === snapshot.artifact.revision ? " · latest" : ""}
                  {entry.approvedAt ? " · approved" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="plan-actions">
            {revision === snapshot.artifact.revision ? (
              <Button
                variant="outline"
                disabled={
                  busy ||
                  !!snapshot.revisions.find((entry) => entry.revision === revision)?.approvedAt
                }
                onClick={() =>
                  void command({
                    action: "approve",
                    name,
                    requestId: crypto.randomUUID(),
                    expectedRevision: revision,
                  })
                }
              >
                Approve version
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void command({
                    action: "restore",
                    name,
                    requestId: crypto.randomUUID(),
                    revision,
                    expectedRevision: snapshot.artifact.revision,
                  })
                }
              >
                Restore this version
              </Button>
            )}
          </div>
        </div>
        <p className="secondary plan-name">
          Agent name: <code>{name}</code>{" "}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(name)}
          >
            Copy name
          </Button>
        </p>
        {snapshot.rounds
          .filter((round) => round.status === "pending")
          .map((round) => (
            <section key={round.id} className="plan-awaiting" aria-label="Pending feedback round">
              <p role="status">
                Awaiting agent · {round.commentIds.length}{" "}
                {round.commentIds.length === 1 ? "comment" : "comments"}
              </p>
              <p className="secondary">
                Feedback is saved. Automatic delivery requires a connected agent. You can also copy
                this request and paste it into your agent's conversation.
              </p>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Copy feedback round"
                onClick={() => void copyRequest(round.id)}
              >
                {copiedRound === round.id ? "Copied agent request" : "Copy agent request"}
              </Button>
            </section>
          ))}
        {copyError && <p role="alert">{copyError}</p>}
        {snapshot.responses.map((response) => (
          <section key={response.id} className="plan-response" aria-label="Agent response">
            <div className="plan-actions">
              <strong>{response.seen ? "Agent response" : "New agent response"}</strong>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void command({
                    action: "seen",
                    name,
                    requestId: crypto.randomUUID(),
                    responseId: response.id,
                    seen: !response.seen,
                  })
                }
              >
                {response.seen ? "Mark unseen" : "Mark seen"}
              </Button>
            </div>
            <p>{response.summary}</p>
            <Button variant="link" onClick={() => onRevision(response.revision)}>
              View version {response.revision}
            </Button>
            {response.replies.map((reply) => (
              <div key={reply.commentId} className="plan-reply">
                <blockquote>
                  {snapshot.comments.find((comment) => comment.id === reply.commentId)?.text}
                </blockquote>
                <p>{reply.text}</p>
              </div>
            ))}
          </section>
        ))}
        <div className="plan-actions" aria-label="Captured comment pins">
          {snapshot.comments.map((comment, index) => (
            <Button
              key={comment.id}
              size="icon-sm"
              variant={selected === comment.id ? "secondary" : "outline"}
              aria-label={`Captured comment ${index + 1}`}
              title={comment.text}
              onClick={() => setSelected(selected === comment.id ? undefined : comment.id)}
            >
              <Pin />
              {index + 1}
            </Button>
          ))}
        </div>
        {selectedComment && (
          <>
            <CommentThread
              key={selectedComment.id}
              comment={selectedComment}
              snapshot={snapshot}
              command={command}
              busy={busy}
              onClose={() => setSelected(undefined)}
            />
            <CommentImage name={name} comment={selectedComment} />
          </>
        )}
      </div>
    </>
  );
}
