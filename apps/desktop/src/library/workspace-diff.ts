import { randomUUID } from "node:crypto";
import {
  MAX_WORKSPACE_TRANSITIONS,
  WORKSPACE_CLOSED_RETENTION_DAYS,
  type WorkspaceBoard,
  type WorkspaceBoardFieldValue,
  type WorkspaceBoardItem,
  type WorkspaceIssueFacts,
  type WorkspaceMilestone,
  type WorkspacePullRequestFacts,
  type WorkspaceTransition,
} from "@irudd-scope/protocol/workspace";

const RETENTION_MS = WORKSPACE_CLOSED_RETENTION_DAYS * 86_400_000;
const MAX_SHORT_TEXT = 512;

function trimShort(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= MAX_SHORT_TEXT ? value : `${value.slice(0, MAX_SHORT_TEXT - 1)}…`;
}

function fieldDisplay(value: WorkspaceBoardFieldValue | undefined): string | null {
  if (!value) return null;
  if (value.text !== null) return trimShort(value.text);
  if (value.number !== null) return String(value.number);
  return null;
}

function transition(
  at: string,
  entityType: WorkspaceTransition["entityType"],
  nodeId: string,
  kind: string,
  field: string | null,
  from: string | null,
  to: string | null,
  summary: string,
): WorkspaceTransition {
  return {
    id: randomUUID(),
    at,
    entityType,
    nodeId,
    kind,
    field: trimShort(field),
    from: trimShort(from),
    to: trimShort(to),
    summary: trimShort(summary) ?? "",
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function diffIssues(
  previous: ReadonlyMap<string, WorkspaceIssueFacts>,
  next: readonly WorkspaceIssueFacts[],
  at: string,
): WorkspaceTransition[] {
  const out: WorkspaceTransition[] = [];
  for (const issue of next) {
    const prev = previous.get(issue.nodeId);
    if (!prev) {
      if (issue.state === "open") {
        out.push(
          transition(
            at,
            "issue",
            issue.nodeId,
            "issue.opened",
            "state",
            null,
            issue.state,
            `Issue #${issue.number} "${issue.title}" observed (open)`,
          ),
        );
      }
      continue;
    }
    if (prev.state !== issue.state) {
      const kind = issue.state === "closed" ? "issue.closed" : "issue.reopened";
      out.push(
        transition(
          at,
          "issue",
          issue.nodeId,
          kind,
          "state",
          prev.state,
          issue.state,
          `Issue #${issue.number} ${issue.state === "closed" ? "closed" : "reopened"}`,
        ),
      );
    }
    if (prev.parentIssueId !== issue.parentIssueId) {
      out.push(
        transition(
          at,
          "issue",
          issue.nodeId,
          "issue.parent-changed",
          "parent",
          prev.parentIssueId,
          issue.parentIssueId,
          `Issue #${issue.number} parent changed`,
        ),
      );
    }
    if (prev.milestoneId !== issue.milestoneId) {
      out.push(
        transition(
          at,
          "issue",
          issue.nodeId,
          "issue.milestone-changed",
          "milestone",
          prev.milestoneId,
          issue.milestoneId,
          `Issue #${issue.number} milestone changed`,
        ),
      );
    }
    if (!sameIds(prev.blockedByIds, issue.blockedByIds)) {
      out.push(
        transition(
          at,
          "issue",
          issue.nodeId,
          "issue.blocked-by-changed",
          "blockedBy",
          prev.blockedByIds.join(",") || null,
          issue.blockedByIds.join(",") || null,
          `Issue #${issue.number} blockers changed (${prev.blockedByIds.length} -> ${issue.blockedByIds.length})`,
        ),
      );
    }
  }
  return out;
}

function diffPullRequests(
  previous: ReadonlyMap<string, WorkspacePullRequestFacts>,
  next: readonly WorkspacePullRequestFacts[],
  at: string,
): WorkspaceTransition[] {
  const out: WorkspaceTransition[] = [];
  for (const pr of next) {
    const prev = previous.get(pr.nodeId);
    if (!prev) {
      out.push(
        transition(
          at,
          "pull-request",
          pr.nodeId,
          "pr.opened",
          "state",
          null,
          pr.draft ? "draft" : pr.state,
          `PR #${pr.number} "${pr.title}" observed (${pr.draft ? "draft" : pr.state})`,
        ),
      );
      continue;
    }
    if (prev.state !== pr.state) {
      const kind =
        pr.state === "merged" ? "pr.merged" : pr.state === "closed" ? "pr.closed" : "pr.reopened";
      out.push(
        transition(
          at,
          "pull-request",
          pr.nodeId,
          kind,
          "state",
          prev.state,
          pr.state,
          `PR #${pr.number} ${pr.state}`,
        ),
      );
    } else if (prev.draft !== pr.draft) {
      out.push(
        transition(
          at,
          "pull-request",
          pr.nodeId,
          pr.draft ? "pr.converted-to-draft" : "pr.ready",
          "draft",
          String(prev.draft),
          String(pr.draft),
          `PR #${pr.number} ${pr.draft ? "converted to draft" : "marked ready for review"}`,
        ),
      );
    }
    const prevDecision = prev.review?.decision ?? null;
    const nextDecision = pr.review?.decision ?? null;
    if (prevDecision !== nextDecision && nextDecision !== null) {
      out.push(
        transition(
          at,
          "pull-request",
          pr.nodeId,
          "pr.review-changed",
          "review",
          prevDecision,
          nextDecision,
          `PR #${pr.number} review ${nextDecision}`,
        ),
      );
    }
    if (
      prev.checks.status !== pr.checks.status &&
      prev.checks.status !== "unknown" &&
      pr.checks.status !== "unknown"
    ) {
      out.push(
        transition(
          at,
          "pull-request",
          pr.nodeId,
          "pr.checks-changed",
          "checks",
          prev.checks.status,
          pr.checks.status,
          `PR #${pr.number} checks ${prev.checks.status} -> ${pr.checks.status}`,
        ),
      );
    }
  }
  return out;
}

function diffBoardItems(
  previous: ReadonlyMap<string, WorkspaceBoardItem>,
  next: readonly WorkspaceBoardItem[],
  at: string,
): WorkspaceTransition[] {
  const out: WorkspaceTransition[] = [];
  const nextIds = new Set<string>();
  for (const item of next) {
    nextIds.add(item.itemId);
    const prev = previous.get(item.itemId);
    const targetNode = item.contentNodeId ?? item.itemId;
    if (!prev) {
      out.push(
        transition(
          at,
          "board-item",
          targetNode,
          "board.item-added",
          null,
          null,
          item.contentType,
          `Item added to board (${item.draftTitle ?? item.contentType})`,
        ),
      );
      continue;
    }
    const prevFields = new Map(prev.fieldValues.map((value) => [value.fieldId, value]));
    const seen = new Set<string>();
    for (const value of item.fieldValues) {
      seen.add(value.fieldId);
      const before = fieldDisplay(prevFields.get(value.fieldId));
      const after = fieldDisplay(value);
      if (before !== after) {
        out.push(
          transition(
            at,
            "board-item",
            targetNode,
            "board.field-changed",
            value.fieldName,
            before,
            after,
            `${value.fieldName}: ${before ?? "(empty)"} -> ${after ?? "(empty)"}`,
          ),
        );
      }
    }
    for (const [fieldId, value] of prevFields) {
      if (seen.has(fieldId)) continue;
      const before = fieldDisplay(value);
      if (before !== null) {
        out.push(
          transition(
            at,
            "board-item",
            targetNode,
            "board.field-changed",
            value.fieldName,
            before,
            null,
            `${value.fieldName}: ${before} -> (empty)`,
          ),
        );
      }
    }
  }
  for (const [itemId, prev] of previous) {
    if (!nextIds.has(itemId)) {
      out.push(
        transition(
          at,
          "board-item",
          prev.contentNodeId ?? itemId,
          "board.item-removed",
          null,
          prev.contentType,
          null,
          `Item removed or archived from board`,
        ),
      );
    }
  }
  return out;
}

export function computeWorkspaceTransitions(
  previous: {
    hasBase: boolean;
    issues: readonly WorkspaceIssueFacts[];
    prs: readonly WorkspacePullRequestFacts[];
    board: WorkspaceBoard | null;
  },
  next: {
    issues: readonly WorkspaceIssueFacts[];
    prs: readonly WorkspacePullRequestFacts[];
    board: WorkspaceBoard | null;
  },
  at: string,
): WorkspaceTransition[] {
  // Initial baseline population should not flood the activity feed with synthetic "opened" events.
  if (!previous.hasBase) return [];
  const prevIssues = new Map(previous.issues.map((issue) => [issue.nodeId, issue]));
  const prevPrs = new Map(previous.prs.map((pr) => [pr.nodeId, pr]));
  const prevBoardItems = new Map((previous.board?.items ?? []).map((item) => [item.itemId, item]));
  const nextBoardItems = next.board?.items ?? [];
  return [
    ...diffIssues(prevIssues, next.issues, at),
    ...diffPullRequests(prevPrs, next.prs, at),
    ...(previous.board && next.board ? diffBoardItems(prevBoardItems, nextBoardItems, at) : []),
  ];
}

export function retainWorkspaceEntities(input: {
  issues: readonly WorkspaceIssueFacts[];
  prs: readonly WorkspacePullRequestFacts[];
  milestones: readonly WorkspaceMilestone[];
  board: WorkspaceBoard | null;
  nowMs: number;
}): {
  issues: WorkspaceIssueFacts[];
  prs: WorkspacePullRequestFacts[];
  milestones: WorkspaceMilestone[];
} {
  const cutoff = input.nowMs - RETENTION_MS;
  const activeBoardNodeIds = new Set(
    (input.board?.items ?? [])
      .filter((item) => !item.isArchived && item.contentNodeId)
      .map((item) => item.contentNodeId!),
  );
  const openIssueIds = new Set(
    input.issues
      .filter((issue) => issue.state === "open" || activeBoardNodeIds.has(issue.nodeId))
      .map((issue) => issue.nodeId),
  );
  const retainedIssues = input.issues.filter((issue) => {
    if (issue.state === "open") return true;
    if (activeBoardNodeIds.has(issue.nodeId)) return true;
    if (issue.parentIssueId && openIssueIds.has(issue.parentIssueId)) return true;
    const stamp = Date.parse(issue.closedAt ?? issue.updatedAt);
    return Number.isFinite(stamp) && stamp >= cutoff;
  });
  const linkedPrIds = new Set(retainedIssues.flatMap((issue) => issue.linkedPrIds));
  const retainedPrs = input.prs.filter((pr) => {
    if (pr.state === "open") return true;
    if (activeBoardNodeIds.has(pr.nodeId)) return true;
    if (linkedPrIds.has(pr.nodeId)) return true;
    const stamp = Date.parse(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt);
    return Number.isFinite(stamp) && stamp >= cutoff;
  });
  const referencedMilestones = new Set(
    [...retainedIssues, ...retainedPrs]
      .map((entry) => entry.milestoneId)
      .filter((id): id is string => id !== null),
  );
  const retainedMilestones = input.milestones.filter(
    (milestone) => milestone.state === "open" || referencedMilestones.has(milestone.nodeId),
  );
  return { issues: retainedIssues, prs: retainedPrs, milestones: retainedMilestones };
}

export function trimTransitions(
  existing: readonly WorkspaceTransition[],
  added: readonly WorkspaceTransition[],
  nowMs: number,
): WorkspaceTransition[] {
  const cutoff = nowMs - RETENTION_MS;
  return [...added, ...existing]
    .filter((entry) => {
      const stamp = Date.parse(entry.at);
      return Number.isFinite(stamp) && stamp >= cutoff;
    })
    .slice(0, MAX_WORKSPACE_TRANSITIONS);
}
