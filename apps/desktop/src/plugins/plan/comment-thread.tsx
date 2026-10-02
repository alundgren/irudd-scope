import type { PlanCommand, PlanComment, PlanSnapshot } from "@irudd-scope/protocol/plan";
import { X } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";

import { FeedbackActions } from "./feedback-actions.tsx";

export function CommentThread({
  comment,
  snapshot,
  command,
  busy,
  onClose,
}: {
  comment: PlanComment;
  snapshot: PlanSnapshot;
  command: (command: PlanCommand) => Promise<boolean>;
  busy: boolean;
  onClose: () => void;
}) {
  const name = snapshot.artifact.name!;
  const round = snapshot.rounds.find((entry) => entry.commentIds.includes(comment.id));
  return (
    <section
      aria-label={`Pinned comment: ${comment.text}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="plan-pin-heading">
        <span className="secondary">
          {comment.resolved
            ? "Resolved"
            : round
              ? round.status === "pending"
                ? "Awaiting agent"
                : "Answered"
              : "Queued"}
        </span>
        <Button size="icon-xs" variant="ghost" aria-label="Close comment" onClick={onClose}>
          <X />
        </Button>
      </div>
      <p className="plan-comment-text">{comment.text}</p>
      {snapshot.responses
        .flatMap((response) => response.replies)
        .filter((reply) => reply.commentId === comment.id)
        .map((reply, index) => (
          <p className="plan-comment-text" key={index}>
            {reply.text}
          </p>
        ))}
      <div className="plan-pin-actions">
        <FeedbackActions
          snapshot={snapshot}
          revision={comment.revision}
          command={command}
          busy={busy}
        />
        <Button
          size="xs"
          variant={round ? "ghost" : "destructive"}
          disabled={busy}
          onClick={() =>
            void command(
              round
                ? {
                    action: "resolve",
                    name,
                    requestId: crypto.randomUUID(),
                    commentId: comment.id,
                    resolved: !comment.resolved,
                  }
                : {
                    action: "delete-comment",
                    name,
                    requestId: crypto.randomUUID(),
                    commentId: comment.id,
                  },
            )
          }
        >
          {round ? (comment.resolved ? "Reopen comment" : "Resolve comment") : "Delete comment"}
        </Button>
      </div>
    </section>
  );
}
