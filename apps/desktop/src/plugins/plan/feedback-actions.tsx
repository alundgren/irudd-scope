import { useRef, useState } from "react";
import type { PlanCommand, PlanSnapshot } from "@irudd-scope/protocol/plan";
import { Copy, Send } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";

function agentRequest(name: string, roundId: string) {
  return `Please review my submitted feedback for Scope plan ${name}, round ${roundId}. Run irudd-scope plan feedback ${name} ${roundId} --output NEW_DIRECTORY using a new output directory. Read packet.json and inspect the annotated PNGs, then address each comment and reply using irudd-scope plan respond. Use irudd-scope plan guide for the response contract.`;
}

export async function copyAgentRequest(name: string, roundId: string) {
  await navigator.clipboard.writeText(agentRequest(name, roundId));
}

export function FeedbackActions({
  snapshot,
  revision,
  command,
  busy,
}: {
  snapshot: PlanSnapshot;
  revision: number;
  command: (command: PlanCommand) => Promise<boolean>;
  busy: boolean;
}) {
  const name = snapshot.artifact.name!;
  const submitted = new Set(snapshot.rounds.flatMap((round) => round.commentIds));
  const queued = snapshot.comments
    .filter(
      (comment) => !comment.resolved && !submitted.has(comment.id) && comment.revision === revision,
    )
    .slice(0, 100);
  const pending = snapshot.rounds.filter((round) => round.status === "pending");
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
  const [copiedRounds, setCopiedRounds] = useState("");
  const copied =
    !queued.length &&
    copiedRounds ===
      pending
        .map((round) => round.id)
        .sort()
        .join(",");
  const [error, setError] = useState("");
  async function submit() {
    const commentIds = queued.map((comment) => comment.id);
    const key = commentIds.join(",");
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    const id = request.current.id;
    return (await command({ action: "submit", name, requestId: id, commentIds })) ? id : undefined;
  }
  async function copy() {
    setError("");
    try {
      const ids = pending.map((round) => round.id);
      if (queued.length) {
        const id = await submit();
        if (!id) return;
        ids.push(id);
      }
      await navigator.clipboard.writeText(ids.map((id) => agentRequest(name, id)).join("\n\n"));
      setCopiedRounds(ids.sort().join(","));
    } catch {
      setError("Could not copy the agent request. Try again.");
    }
  }
  if (!queued.length && !pending.length) return null;
  return (
    <div className="plan-feedback-actions">
      <Button
        size="xs"
        variant="ghost"
        aria-label={copied ? "Copied agent request" : "Copy agent request"}
        title="Copy feedback for your agent"
        disabled={busy}
        onClick={() => void copy()}
      >
        <Copy />
        {copied ? "Copied" : "Copy"}
      </Button>
      {!!queued.length && (
        <Button
          size="xs"
          aria-label={`Send feedback (${queued.length})`}
          title="Send collected comments"
          disabled={busy}
          onClick={() => void submit()}
        >
          <Send />
          Send {queued.length}
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
