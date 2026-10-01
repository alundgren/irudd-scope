import { useEffect, useState } from "react";
import type { PlanCommand, PlanComment, PlanSnapshot } from "@irudd-scope/protocol/plan";
import { X } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";

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
  const submitted = new Set(snapshot.rounds.flatMap((round) => round.commentIds));
  const queued = snapshot.comments.filter(
    (comment) => !comment.resolved && !submitted.has(comment.id) && comment.revision === revision,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [copiedRound, setCopiedRound] = useState("");
  const [copyError, setCopyError] = useState("");
  useEffect(() => setSelected([]), [revision]);
  const validSelection = queued
    .filter((comment) => selected.includes(comment.id))
    .map((comment) => comment.id);
  const sendIds = (
    validSelection.length ? validSelection : queued.map((comment) => comment.id)
  ).slice(0, 100);
  const write = (action: Omit<Extract<PlanCommand, { action: "resolve" }>, "name" | "requestId">) =>
    void command({ ...action, name, requestId: crypto.randomUUID() });
  async function send() {
    if (
      await command({ action: "submit", name, requestId: crypto.randomUUID(), commentIds: sendIds })
    )
      setSelected([]);
  }
  async function copyRequest(roundId: string) {
    setCopyError("");
    setCopiedRound("");
    try {
      await navigator.clipboard.writeText(
        `Please review my submitted feedback for Scope plan ${name}, round ${roundId}. Run irudd-scope plan feedback ${name} ${roundId} --output NEW_DIRECTORY using a new output directory. Read packet.json and inspect the annotated PNGs, then address each comment and reply using irudd-scope plan respond. Use irudd-scope plan guide for the response contract.`,
      );
      setCopiedRound(roundId);
    } catch {
      setCopyError("Could not copy the agent request. Try again.");
    }
  }
  return (
    <aside className="plan-review" aria-label="Plan feedback">
      <div className="plan-review-heading">
        <h2>Feedback</h2>
        <Button variant="ghost" size="icon" aria-label="Hide feedback" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="plan-review-scroll">
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
        {queued.length > 0 && (
          <div className="plan-send">
            <Button disabled={busy || !sendIds.length} onClick={() => void send()}>
              Send feedback
              {` (${sendIds.length})`}
            </Button>
            <p className="secondary">
              {validSelection.length
                ? "Send selected comments."
                : `Send queued comments for version ${revision}.`}
              {queued.length > 100 &&
                " Up to 100 comments per round. Remaining comments stay queued."}
            </p>
          </div>
        )}
        {!snapshot.comments.length && (
          <p className="secondary">
            Navigate the plan, then use Comment to capture the page and add feedback.
          </p>
        )}
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
              <Button size="xs" variant="ghost" onClick={() => void copyRequest(round.id)}>
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
        {[...snapshot.comments].reverse().map((comment) => (
          <section
            key={comment.id}
            className="plan-comment"
            aria-label={`Comment: ${comment.text}`}
          >
            <div className="plan-actions">
              {!comment.resolved && !submitted.has(comment.id) && comment.revision === revision && (
                <label className="plan-queue-choice">
                  <input
                    type="checkbox"
                    checked={validSelection.includes(comment.id)}
                    disabled={
                      busy || (!validSelection.includes(comment.id) && validSelection.length >= 100)
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...validSelection, comment.id]
                          : validSelection.filter((id) => id !== comment.id),
                      )
                    }
                  />
                  Queue
                </label>
              )}
              <span className="secondary">
                Version {comment.revision}
                {comment.page ? ` · ${comment.page}` : ""} ·{" "}
                {comment.resolved ? "Resolved" : submitted.has(comment.id) ? "Sent" : "Queued"}
              </span>
            </div>
            <p className="plan-comment-text">{comment.text}</p>
            <CommentImage name={name} comment={comment} />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                write({ action: "resolve", commentId: comment.id, resolved: !comment.resolved })
              }
            >
              {comment.resolved ? "Reopen comment" : "Resolve comment"}
            </Button>
          </section>
        ))}
      </div>
    </aside>
  );
}
