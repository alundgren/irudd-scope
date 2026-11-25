import {
  type WorkspaceBoard,
  type WorkspaceBoardField,
  type WorkspaceBoardFieldValue,
  type WorkspaceBoardItem,
  type WorkspaceBoardRef,
  type WorkspaceBoardView,
  type WorkspaceIssueDetail,
  type WorkspaceIssueFacts,
  type WorkspaceMilestone,
  type WorkspacePullRequestDetail,
  type WorkspacePullRequestFacts,
  type WorkspaceRepository,
} from "@irudd-scope/protocol/github-workspace";
import {
  GhCliTransport,
  WorkspaceGitHubError,
  type GitHubRateObservation,
  type GitHubTransport,
} from "./transport.ts";

const PR_FIELDS = `
  id number title state isDraft url createdAt updatedAt mergedAt closedAt
  headRefOid headRefName baseRefOid additions deletions changedFiles mergeable
  author { login }
  milestone { id }
  labels(first: 50) { nodes { name } }
  reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } }
  reviewDecision
  latestOpinionatedReviews(first: 50) { nodes { state } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state commit { oid } } } } }
  closingIssuesReferences(first: 10) { nodes { id } }
  isMergeQueueEnabled
  mergeQueue { url nextEntryEstimatedTimeToMerge entries(first: 0) { totalCount } }
  mergeQueueEntry { position state enqueuedAt enqueuer { login } estimatedTimeToMerge jump solo headCommit { oid } baseCommit { oid } }
`;

const OPEN_PRS_QUERY = `query WorkspaceOpenPRs($owner: String!, $name: String!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    pullRequests(states: OPEN, first: 25, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;

const PRS_BY_IDS_QUERY = `query WorkspacePRsByIds($ids: [ID!]!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  nodes(ids: $ids) { ... on PullRequest { ${PR_FIELDS} } }
}`;

const ISSUE_SLIM_FIELDS = `
  id number title state stateReason url createdAt updatedAt closedAt
  author { login }
  issueType { id name }
  milestone { id }
  parent { id }
  subIssuesSummary { total completed percentCompleted }
  issueDependenciesSummary { blockedBy blocking }
`;

const ISSUE_FULL_FIELDS = `
  ${ISSUE_SLIM_FIELDS}
  assignees(first: 10) { nodes { login } }
  labels(first: 25) { nodes { name } }
  blockedBy(first: 20) { nodes { id } }
  blocking(first: 20) { nodes { id } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
    nodes { id number title state isDraft url createdAt updatedAt mergedAt closedAt headRefName headRefOid baseRefOid author { login } }
  }
`;

const REPO_DELTA_QUERY = `query WorkspaceRepoDelta($owner: String!, $name: String!, $since: DateTime, $cursor: String, $boardOrg: Boolean!, $boardUser: Boolean!, $boardOwner: String!, $boardNumber: Int!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    milestones(first: 100) {
      nodes { id number title description state dueOn updatedAt open: issues(states: OPEN) { totalCount } closed: issues(states: CLOSED) { totalCount } }
    }
    issues(first: 100, after: $cursor, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_SLIM_FIELDS} }
    }
  }
  orgBoard: organization(login: $boardOwner) @include(if: $boardOrg) {
    projectV2(number: $boardNumber) { id updatedAt }
  }
  userBoard: user(login: $boardOwner) @include(if: $boardUser) {
    projectV2(number: $boardNumber) { id updatedAt }
  }
}`;

const OPEN_ISSUES_SWEEP_QUERY = `query WorkspaceOpenIssuesSweep($owner: String!, $name: String!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_SLIM_FIELDS} }
    }
  }
}`;

const HYDRATE_ISSUES_QUERY = `query WorkspaceHydrateIssues($ids: [ID!]!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  nodes(ids: $ids) { ... on Issue { ${ISSUE_FULL_FIELDS} } }
}`;

const BOARD_SCHEMA_QUERY = `query WorkspaceBoardSchema($boardOrg: Boolean!, $boardOwner: String!, $boardNumber: Int!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  orgBoard: organization(login: $boardOwner) @include(if: $boardOrg) {
    projectV2(number: $boardNumber) { ...BoardSchemaFields }
  }
  userBoard: user(login: $boardOwner) @skip(if: $boardOrg) {
    projectV2(number: $boardNumber) { ...BoardSchemaFields }
  }
}
fragment BoardSchemaFields on ProjectV2 {
  id number title url updatedAt
  fields(first: 50) {
    nodes {
      ... on ProjectV2Field { id name dataType }
      ... on ProjectV2SingleSelectField { id name dataType options { id name color description } }
      ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } }
    }
  }
  views(first: 20) { nodes { id number name layout filter } }
}`;

const BOARD_ITEMS_QUERY = `query WorkspaceBoardItems($boardOrg: Boolean!, $boardOwner: String!, $boardNumber: Int!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  orgBoard: organization(login: $boardOwner) @include(if: $boardOrg) {
    projectV2(number: $boardNumber) { ...BoardItemsFields }
  }
  userBoard: user(login: $boardOwner) @skip(if: $boardOrg) {
    projectV2(number: $boardNumber) { ...BoardItemsFields }
  }
}
fragment BoardItemsFields on ProjectV2 {
  id updatedAt
  items(first: 100, after: $cursor, archivedStates: [NOT_ARCHIVED], orderBy: { field: POSITION, direction: ASC }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id type isArchived createdAt updatedAt
      content {
        __typename
        ... on Issue { id }
        ... on PullRequest { id }
        ... on DraftIssue { id title }
      }
      fieldValues(first: 15) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue { name optionId updatedAt field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldIterationValue { title iterationId updatedAt field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldNumberValue { number updatedAt field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldDateValue { date updatedAt field { ... on ProjectV2FieldCommon { id name } } }
          ... on ProjectV2ItemFieldTextValue { text updatedAt field { ... on ProjectV2FieldCommon { id name } } }
        }
      }
    }
  }
}`;

const ISSUE_DETAIL_QUERY = `query WorkspaceIssueDetail($id: ID!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  node(id: $id) {
    ... on Issue {
      id body
      comments(last: 50) { nodes { id author { login } body createdAt } }
      timelineItems(last: 50, itemTypes: [
        CLOSED_EVENT, REOPENED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT,
        SUB_ISSUE_ADDED_EVENT, SUB_ISSUE_REMOVED_EVENT,
        PARENT_ISSUE_ADDED_EVENT, PARENT_ISSUE_REMOVED_EVENT,
        BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT,
        CONNECTED_EVENT, DISCONNECTED_EVENT,
        PROJECT_V2_ITEM_STATUS_CHANGED_EVENT, ADDED_TO_PROJECT_V2_EVENT, REMOVED_FROM_PROJECT_V2_EVENT
      ]) {
        nodes {
          __typename
          ... on ClosedEvent { createdAt actor { login } }
          ... on ReopenedEvent { createdAt actor { login } }
          ... on MilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on DemilestonedEvent { createdAt actor { login } milestoneTitle }
          ... on SubIssueAddedEvent { createdAt actor { login } subIssue { number title } }
          ... on SubIssueRemovedEvent { createdAt actor { login } subIssue { number title } }
          ... on ParentIssueAddedEvent { createdAt actor { login } parent { number title } }
          ... on ParentIssueRemovedEvent { createdAt actor { login } parent { number title } }
          ... on BlockedByAddedEvent { createdAt actor { login } blockingIssue { number title } }
          ... on BlockedByRemovedEvent { createdAt actor { login } blockingIssue { number title } }
          ... on ConnectedEvent { createdAt actor { login } }
          ... on DisconnectedEvent { createdAt actor { login } }
          ... on ProjectV2ItemStatusChangedEvent { createdAt actor { login } previousStatus status }
          ... on AddedToProjectV2Event { createdAt actor { login } }
          ... on RemovedFromProjectV2Event { createdAt actor { login } }
        }
      }
    }
  }
}`;

const PR_VIEW_QUERY = `query WorkspacePRView($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id state headRefOid baseRefOid body }
  }
}`;

type RawPageInfo = { hasNextPage: boolean; endCursor: string | null };
type RawAny = Record<string, any>;

const COMMIT_OID = /^[a-f0-9]{40,64}$/;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function truncateTitle(value: unknown, fallback = "(untitled)"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return truncate(text || fallback, 1024);
}

function truncateNullable(value: unknown, max: number): string | null {
  return typeof value === "string" ? truncate(value, max) : null;
}

function validOid(value: unknown): string | null {
  return typeof value === "string" && COMMIT_OID.test(value) ? value : null;
}

function mapStateReason(value: string | null | undefined): WorkspaceIssueFacts["stateReason"] {
  if (value === "COMPLETED") return "completed";
  if (value === "NOT_PLANNED") return "not-planned";
  if (value === "REOPENED") return "reopened";
  if (value === "DUPLICATE") return "duplicate";
  return null;
}

function mapPrState(value: string): WorkspacePullRequestFacts["state"] {
  if (value === "MERGED") return "merged";
  if (value === "CLOSED") return "closed";
  return "open";
}

function mapPrNode(node: RawAny, observedAt: string): WorkspacePullRequestFacts {
  const headOid = validOid(node.headRefOid);
  const baseOid = validOid(node.baseRefOid);
  const rollup = node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup;
  const rollupOid = validOid(rollup?.commit?.oid);
  const checkStatus =
    !rollup || !headOid || rollupOid !== headOid
      ? "unknown"
      : rollup.state === "SUCCESS"
        ? "passing"
        : rollup.state === "FAILURE" || rollup.state === "ERROR"
          ? "failing"
          : rollup.state === "PENDING" || rollup.state === "EXPECTED"
            ? "pending"
            : "unknown";
  const opinions: { state: string }[] = node.latestOpinionatedReviews?.nodes ?? [];
  const decision =
    node.reviewDecision === "APPROVED"
      ? "approved"
      : node.reviewDecision === "CHANGES_REQUESTED"
        ? "changes-requested"
        : node.reviewDecision === "REVIEW_REQUIRED"
          ? "review-required"
          : null;
  const review = headOid
    ? {
        decision: decision as "approved" | "changes-requested" | "review-required" | null,
        hasApproval: opinions.some((opinion) => opinion.state === "APPROVED"),
        headOid,
        observedAt,
      }
    : undefined;
  const threads: { isResolved: boolean }[] | undefined = node.reviewThreads?.nodes;
  const requestedReviewers = ((node.reviewRequests?.nodes ?? []) as RawAny[])
    .flatMap((req) => {
      const r = req.requestedReviewer;
      if (!r) return [];
      if (typeof r.login === "string" && r.login) return [truncate(r.login, 512)];
      if (typeof r.organization?.login === "string" && typeof r.slug === "string") {
        return [truncate(`${r.organization.login}/${r.slug}`, 512)];
      }
      return [];
    })
    .slice(0, 100);
  const queueEntry = node.mergeQueueEntry;
  const queueStateMap: Record<
    string,
    "queued" | "awaiting-checks" | "mergeable" | "unmergeable" | "locked"
  > = {
    QUEUED: "queued",
    AWAITING_CHECKS: "awaiting-checks",
    MERGEABLE: "mergeable",
    UNMERGEABLE: "unmergeable",
    LOCKED: "locked",
  };
  return {
    nodeId: node.id,
    number: node.number,
    title: truncateTitle(node.title),
    state: mapPrState(node.state),
    author: truncateNullable(node.author?.login, 512),
    labels: ((node.labels?.nodes ?? []) as RawAny[])
      .filter((l) => typeof l?.name === "string")
      .map((l) => truncate(l.name, 512))
      .slice(0, 100),
    requestedReviewers,
    headOid,
    headRefName: truncate(typeof node.headRefName === "string" ? node.headRefName : "", 512),
    baseOid,
    ...(review ? { review } : {}),
    ...(node.isMergeQueueEnabled !== undefined
      ? {
          queue: {
            enabled: node.isMergeQueueEnabled === true,
            url: truncateNullable(node.mergeQueue?.url, 2048),
            size: node.mergeQueue?.entries?.totalCount ?? null,
            nextEntryEstimatedSecondsToMerge:
              node.mergeQueue?.nextEntryEstimatedTimeToMerge ?? null,
            entry: queueEntry
              ? {
                  position: queueEntry.position,
                  state: queueStateMap[queueEntry.state] ?? "queued",
                  enqueuedAt: queueEntry.enqueuedAt,
                  enqueuer: truncateNullable(queueEntry.enqueuer?.login, 512),
                  estimatedSecondsToMerge: queueEntry.estimatedTimeToMerge ?? null,
                  jump: Boolean(queueEntry.jump),
                  solo: Boolean(queueEntry.solo),
                  headOid: validOid(queueEntry.headCommit?.oid),
                  baseOid: validOid(queueEntry.baseCommit?.oid),
                }
              : null,
            observedAt,
          },
        }
      : {}),
    draft: Boolean(node.isDraft),
    additions: Math.max(0, node.additions ?? 0),
    deletions: Math.max(0, node.deletions ?? 0),
    changedFiles: Math.max(0, node.changedFiles ?? 0),
    milestoneId: node.milestone?.id ?? null,
    closingIssueIds: ((node.closingIssuesReferences?.nodes ?? []) as RawAny[])
      .filter((i) => typeof i?.id === "string")
      .map((i) => i.id)
      .slice(0, 100),
    merge: {
      status:
        node.mergeable === "MERGEABLE"
          ? "clear"
          : node.mergeable === "CONFLICTING"
            ? "conflicting"
            : "unknown",
      headOid,
      baseOid,
      observedAt,
    },
    checks: { status: checkStatus, headOid: rollupOid, observedAt },
    hasUnresolvedConversations: threads ? threads.some((t) => !t.isResolved) : null,
    url: truncate(String(node.url ?? ""), 2048),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
  };
}

function mapStubPr(node: RawAny, observedAt: string): WorkspacePullRequestFacts {
  const headOid = validOid(node.headRefOid);
  const baseOid = validOid(node.baseRefOid);
  return {
    nodeId: node.id,
    number: node.number,
    title: truncateTitle(node.title),
    state: mapPrState(node.state),
    author: truncateNullable(node.author?.login, 512),
    labels: [],
    requestedReviewers: [],
    headOid,
    headRefName: truncate(typeof node.headRefName === "string" ? node.headRefName : "", 512),
    baseOid,
    draft: Boolean(node.isDraft),
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    milestoneId: null,
    closingIssueIds: [],
    merge: {
      status: "unknown",
      headOid,
      baseOid,
      observedAt,
    },
    checks: { status: "unknown", headOid: null, observedAt },
    hasUnresolvedConversations: null,
    url: truncate(String(node.url ?? ""), 2048),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
  };
}

export type SlimIssueRecord = {
  nodeId: string;
  number: number;
  title: string;
  state: "open" | "closed";
  stateReason: WorkspaceIssueFacts["stateReason"];
  author: string | null;
  issueType: { id: string; name: string } | null;
  milestoneId: string | null;
  parentIssueId: string | null;
  subIssuesSummary: { total: number; completed: number; percentCompleted: number };
  dependenciesSummary: { blockedBy: number; blocking: number };
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

function mapSlimIssue(node: RawAny): SlimIssueRecord {
  return {
    nodeId: node.id,
    number: node.number,
    title: truncateTitle(node.title),
    state: node.state === "CLOSED" ? "closed" : "open",
    stateReason: mapStateReason(node.stateReason),
    author: truncateNullable(node.author?.login, 512),
    issueType: node.issueType
      ? { id: node.issueType.id, name: truncate(String(node.issueType.name ?? ""), 512) }
      : null,
    milestoneId: node.milestone?.id ?? null,
    parentIssueId: node.parent?.id ?? null,
    subIssuesSummary: {
      total: Math.max(0, node.subIssuesSummary?.total ?? 0),
      completed: Math.max(0, node.subIssuesSummary?.completed ?? 0),
      percentCompleted: Math.max(0, node.subIssuesSummary?.percentCompleted ?? 0),
    },
    dependenciesSummary: {
      blockedBy: Math.max(0, node.issueDependenciesSummary?.blockedBy ?? 0),
      blocking: Math.max(0, node.issueDependenciesSummary?.blocking ?? 0),
    },
    url: truncate(String(node.url ?? ""), 2048),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt ?? null,
  };
}

function mapFullIssue(
  node: RawAny,
  observedAt: string,
): {
  issue: WorkspaceIssueFacts;
  linkedPrStubs: WorkspacePullRequestFacts[];
} {
  const slim = mapSlimIssue(node);
  const prNodes: RawAny[] = ((node.closedByPullRequestsReferences?.nodes ?? []) as RawAny[]).filter(
    (p) => typeof p?.id === "string",
  );
  return {
    issue: {
      ...slim,
      assignees: ((node.assignees?.nodes ?? []) as RawAny[])
        .filter((a) => typeof a?.login === "string")
        .map((a) => truncate(a.login, 512))
        .slice(0, 100),
      labels: ((node.labels?.nodes ?? []) as RawAny[])
        .filter((l) => typeof l?.name === "string")
        .map((l) => truncate(l.name, 512))
        .slice(0, 100),
      blockedByIds: ((node.blockedBy?.nodes ?? []) as RawAny[])
        .filter((b) => typeof b?.id === "string")
        .map((b) => b.id)
        .slice(0, 200),
      blockingIds: ((node.blocking?.nodes ?? []) as RawAny[])
        .filter((b) => typeof b?.id === "string")
        .map((b) => b.id)
        .slice(0, 200),
      linkedPrIds: prNodes.map((p) => p.id).slice(0, 100),
    },
    linkedPrStubs: prNodes.map((p) => mapStubPr(p, observedAt)),
  };
}

function mapBoardFieldValue(node: RawAny): WorkspaceBoardFieldValue | null {
  const field = node.field;
  if (!field?.id || !field?.name) return null;
  const fieldName = truncate(String(field.name), 512);
  const type = node.__typename;
  if (type === "ProjectV2ItemFieldSingleSelectValue") {
    return {
      fieldId: field.id,
      fieldName,
      type: "single-select",
      text: truncateNullable(node.name, 20_000),
      number: null,
      optionId: truncateNullable(node.optionId, 512),
      iterationId: null,
      updatedAt: node.updatedAt ?? null,
    };
  }
  if (type === "ProjectV2ItemFieldIterationValue") {
    return {
      fieldId: field.id,
      fieldName,
      type: "iteration",
      text: truncateNullable(node.title, 20_000),
      number: null,
      optionId: null,
      iterationId: truncateNullable(node.iterationId, 512),
      updatedAt: node.updatedAt ?? null,
    };
  }
  if (type === "ProjectV2ItemFieldNumberValue") {
    return {
      fieldId: field.id,
      fieldName,
      type: "number",
      text: null,
      number: typeof node.number === "number" && Number.isFinite(node.number) ? node.number : null,
      optionId: null,
      iterationId: null,
      updatedAt: node.updatedAt ?? null,
    };
  }
  if (type === "ProjectV2ItemFieldDateValue") {
    return {
      fieldId: field.id,
      fieldName,
      type: "date",
      text: truncateNullable(node.date, 20_000),
      number: null,
      optionId: null,
      iterationId: null,
      updatedAt: node.updatedAt ?? null,
    };
  }
  if (type === "ProjectV2ItemFieldTextValue") {
    return {
      fieldId: field.id,
      fieldName,
      type: "text",
      text: truncateNullable(node.text, 20_000),
      number: null,
      optionId: null,
      iterationId: null,
      updatedAt: node.updatedAt ?? null,
    };
  }
  return null;
}

function formatTimelineEvent(
  node: RawAny,
): { type: string; at: string; actor: string | null; summary: string } | null {
  if (!node?.createdAt || !node?.__typename) return null;
  const actor = truncateNullable(node.actor?.login, 512);
  const type = truncate(String(node.__typename), 512);
  let summary = type.replace(/Event$/, "");
  if (type === "ProjectV2ItemStatusChangedEvent")
    summary = `Status: ${node.previousStatus ?? "(empty)"} -> ${node.status ?? "(empty)"}`;
  else if (type === "MilestonedEvent") summary = `Added to milestone "${node.milestoneTitle}"`;
  else if (type === "DemilestonedEvent")
    summary = `Removed from milestone "${node.milestoneTitle}"`;
  else if (type === "SubIssueAddedEvent" && node.subIssue)
    summary = `Added sub-issue #${node.subIssue.number}`;
  else if (type === "SubIssueRemovedEvent" && node.subIssue)
    summary = `Removed sub-issue #${node.subIssue.number}`;
  else if (type === "BlockedByAddedEvent" && node.blockingIssue)
    summary = `Blocked by #${node.blockingIssue.number}`;
  else if (type === "BlockedByRemovedEvent" && node.blockingIssue)
    summary = `Unblocked from #${node.blockingIssue.number}`;
  return { type, at: node.createdAt, actor, summary: truncate(summary, 512) };
}

export class WorkspaceGitHubClient {
  constructor(private readonly transport: GitHubTransport = new GhCliTransport()) {}

  setHooks(
    observe?: (observation: GitHubRateObservation) => void,
    beforeRead?: (signal: AbortSignal) => Promise<void> | void,
  ): void {
    this.transport.setHooks(observe, beforeRead);
  }

  account(signal: AbortSignal): Promise<string> {
    return this.transport.account(signal);
  }

  async readOpenPullRequests(
    repository: WorkspaceRepository,
    signal: AbortSignal,
  ): Promise<{
    repository: WorkspaceRepository;
    viewer: string;
    prs: WorkspacePullRequestFacts[];
    cost: number;
  }> {
    let cursor: string | null = null;
    let cost = 0;
    let viewer = "";
    let resolved = repository;
    const prs: WorkspacePullRequestFacts[] = [];
    const seen = new Set<string>();
    do {
      const { data, observation } = await this.transport.graphql<RawAny>(
        OPEN_PRS_QUERY,
        { owner: repository.owner, name: repository.name, cursor },
        signal,
        0,
      );
      cost += observation.cost;
      viewer = observation.account;
      const repo = data.repository;
      if (!repo)
        throw new WorkspaceGitHubError(
          "Your GitHub CLI account cannot read this repository.",
          "permission",
        );
      resolved = { owner: repo.owner.login, name: repo.name };
      const stamp = new Date().toISOString();
      for (const node of repo.pullRequests.nodes as RawAny[]) prs.push(mapPrNode(node, stamp));
      const pageInfo: RawPageInfo = repo.pullRequests.pageInfo;
      cursor =
        pageInfo.hasNextPage && pageInfo.endCursor && !seen.has(pageInfo.endCursor)
          ? pageInfo.endCursor
          : null;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { repository: resolved, viewer, prs, cost };
  }

  async readPullRequestsByIds(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{ prs: WorkspacePullRequestFacts[]; cost: number }> {
    const prs: WorkspacePullRequestFacts[] = [];
    let cost = 0;
    const stamp = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const { data, observation } = await this.transport.graphql<RawAny>(
        PRS_BY_IDS_QUERY,
        { ids: batch },
        signal,
        0,
        { allowNotFound: true },
      );
      cost += observation.cost;
      for (const node of (data.nodes ?? []) as RawAny[]) {
        if (node?.id) prs.push(mapPrNode(node, stamp));
      }
    }
    return { prs, cost };
  }

  async readRepoDelta(
    repository: WorkspaceRepository,
    since: string | null,
    boardRef: WorkspaceBoardRef | null,
    signal: AbortSignal,
  ): Promise<{
    milestones: WorkspaceMilestone[];
    issues: SlimIssueRecord[];
    boardUpdatedAt: string | null;
    boardError: string | null;
    cost: number;
  }> {
    let cursor: string | null = null;
    let cost = 0;
    let milestones: WorkspaceMilestone[] = [];
    let boardUpdatedAt: string | null = null;
    let boardError: string | null = null;
    const issues: SlimIssueRecord[] = [];
    const seen = new Set<string>();
    let includeBoard = boardRef !== null;

    while (true) {
      const queryBoard = includeBoard && cursor === null;
      let data: RawAny;
      try {
        const res = await this.transport.graphql<RawAny>(
          REPO_DELTA_QUERY,
          {
            owner: repository.owner,
            name: repository.name,
            since,
            cursor,
            boardOrg: queryBoard && boardRef?.ownerType === "organization",
            boardUser: queryBoard && boardRef?.ownerType === "user",
            boardOwner: boardRef?.owner ?? repository.owner,
            boardNumber: boardRef?.number ?? 1,
          },
          signal,
          0,
        );
        data = res.data;
        cost += res.observation.cost;
      } catch (error) {
        if (
          queryBoard &&
          error instanceof WorkspaceGitHubError &&
          (error.kind === "scope" || error.kind === "permission")
        ) {
          boardError = error.message;
          includeBoard = false;
          continue;
        }
        throw error;
      }
      const repo = data.repository;
      if (!repo)
        throw new WorkspaceGitHubError(
          "Your GitHub CLI account cannot read this repository.",
          "permission",
        );
      if (cursor === null) {
        milestones = ((repo.milestones?.nodes ?? []) as RawAny[]).map((m) => ({
          nodeId: m.id,
          number: m.number,
          title: truncateTitle(m.title),
          description: truncate(typeof m.description === "string" ? m.description : "", 20_000),
          state: m.state === "CLOSED" ? "closed" : "open",
          dueOn: m.dueOn ?? null,
          updatedAt: m.updatedAt,
          openIssues: Math.max(0, m.open?.totalCount ?? 0),
          closedIssues: Math.max(0, m.closed?.totalCount ?? 0),
        }));
        const proj = data.orgBoard?.projectV2 ?? data.userBoard?.projectV2;
        if (queryBoard) boardUpdatedAt = proj?.updatedAt ?? null;
      }
      for (const node of repo.issues.nodes as RawAny[]) issues.push(mapSlimIssue(node));
      const pageInfo: RawPageInfo = repo.issues.pageInfo;
      cursor =
        pageInfo.hasNextPage && pageInfo.endCursor && !seen.has(pageInfo.endCursor)
          ? pageInfo.endCursor
          : null;
      if (!cursor) break;
      seen.add(cursor);
    }

    return { milestones, issues, boardUpdatedAt, boardError, cost };
  }

  async readOpenIssueSweep(
    repository: WorkspaceRepository,
    signal: AbortSignal,
  ): Promise<{ issues: SlimIssueRecord[]; cost: number }> {
    let cursor: string | null = null;
    let cost = 0;
    const issues: SlimIssueRecord[] = [];
    const seen = new Set<string>();
    do {
      const { data, observation } = await this.transport.graphql<RawAny>(
        OPEN_ISSUES_SWEEP_QUERY,
        { owner: repository.owner, name: repository.name, cursor },
        signal,
        0,
      );
      cost += observation.cost;
      const repo = data.repository;
      if (!repo) throw new WorkspaceGitHubError("Repository not accessible.", "permission");
      for (const node of repo.issues.nodes as RawAny[]) issues.push(mapSlimIssue(node));
      const pageInfo: RawPageInfo = repo.issues.pageInfo;
      cursor =
        pageInfo.hasNextPage && pageInfo.endCursor && !seen.has(pageInfo.endCursor)
          ? pageInfo.endCursor
          : null;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { issues, cost };
  }

  async hydrateIssues(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    issues: WorkspaceIssueFacts[];
    linkedPrStubs: WorkspacePullRequestFacts[];
    cost: number;
  }> {
    const issues: WorkspaceIssueFacts[] = [];
    const stubMap = new Map<string, WorkspacePullRequestFacts>();
    let cost = 0;
    const stamp = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 25) {
      const batch = ids.slice(i, i + 25);
      const { data, observation } = await this.transport.graphql<RawAny>(
        HYDRATE_ISSUES_QUERY,
        { ids: batch },
        signal,
        0,
        { allowNotFound: true },
      );
      cost += observation.cost;
      for (const node of (data.nodes ?? []) as RawAny[]) {
        if (!node?.id) continue;
        const mapped = mapFullIssue(node, stamp);
        issues.push(mapped.issue);
        for (const stub of mapped.linkedPrStubs) stubMap.set(stub.nodeId, stub);
      }
    }
    return { issues, linkedPrStubs: [...stubMap.values()], cost };
  }

  private async fetchBoardSchema(
    boardRef: WorkspaceBoardRef,
    vars: { boardOrg: boolean; boardOwner: string; boardNumber: number },
    signal: AbortSignal,
  ): Promise<{
    schema: Pick<WorkspaceBoard, "nodeId" | "title" | "url" | "fields" | "views">;
    updatedAt: string;
    cost: number;
  }> {
    const res = await this.transport.graphql<RawAny>(BOARD_SCHEMA_QUERY, vars, signal, 0);
    const proj = res.data.orgBoard?.projectV2 ?? res.data.userBoard?.projectV2;
    if (!proj)
      throw new WorkspaceGitHubError(
        `Project #${boardRef.number} under ${boardRef.owner} was not found or is inaccessible.`,
        "permission",
      );
    const fields: WorkspaceBoardField[] = ((proj.fields?.nodes ?? []) as RawAny[])
      .filter((f) => f?.id && f?.name)
      .slice(0, 100)
      .map((f) => ({
        id: f.id,
        name: truncate(String(f.name), 512),
        dataType: truncate(String(f.dataType ?? "TEXT"), 512),
        options: ((f.options ?? []) as RawAny[]).slice(0, 200).map((o) => ({
          id: truncate(String(o.id), 512),
          name: truncate(String(o.name), 512),
          color: truncateNullable(o.color, 512),
          description: truncateNullable(o.description, 512),
        })),
        iterations: ((f.configuration?.iterations ?? []) as RawAny[]).slice(0, 200).map((it) => ({
          id: truncate(String(it.id), 512),
          title: truncate(String(it.title), 512),
          startDate: truncate(String(it.startDate), 512),
          duration: Math.max(0, it.duration ?? 0),
        })),
      }));
    const views: WorkspaceBoardView[] = ((proj.views?.nodes ?? []) as RawAny[])
      .filter((v) => v?.id)
      .slice(0, 50)
      .map((v) => ({
        id: v.id,
        number: v.number,
        name: truncate(String(v.name ?? ""), 512),
        layout: truncate(String(v.layout ?? ""), 512),
        filter: truncateNullable(v.filter, 20_000),
      }));
    return {
      schema: {
        nodeId: proj.id,
        title: truncate(typeof proj.title === "string" ? proj.title : "", 1024),
        url: truncate(String(proj.url ?? ""), 2048),
        fields,
        views,
      },
      updatedAt: proj.updatedAt,
      cost: res.observation.cost,
    };
  }

  async readBoard(
    boardRef: WorkspaceBoardRef,
    existingSchema: Pick<WorkspaceBoard, "nodeId" | "title" | "url" | "fields" | "views"> | null,
    signal: AbortSignal,
  ): Promise<{ board: WorkspaceBoard; cost: number; schemaRefreshed: boolean }> {
    let cost = 0;
    let schema = existingSchema;
    let schemaRefreshed = false;
    let updatedAt = "";
    const vars = {
      boardOrg: boardRef.ownerType === "organization",
      boardOwner: boardRef.owner,
      boardNumber: boardRef.number,
    };
    if (!schema) {
      const fetched = await this.fetchBoardSchema(boardRef, vars, signal);
      cost += fetched.cost;
      updatedAt = fetched.updatedAt;
      schema = fetched.schema;
      schemaRefreshed = true;
    }

    let cursor: string | null = null;
    const seen = new Set<string>();
    const items: WorkspaceBoardItem[] = [];
    let position = 0;
    do {
      const res = await this.transport.graphql<RawAny>(
        BOARD_ITEMS_QUERY,
        { ...vars, cursor },
        signal,
        0,
      );
      cost += res.observation.cost;
      const proj = res.data.orgBoard?.projectV2 ?? res.data.userBoard?.projectV2;
      if (!proj)
        throw new WorkspaceGitHubError(
          "Project board became inaccessible during refresh.",
          "permission",
        );
      if (position === 0 && schema.nodeId !== proj.id) {
        const fetched = await this.fetchBoardSchema(boardRef, vars, signal);
        cost += fetched.cost;
        schema = fetched.schema;
        schemaRefreshed = true;
      }
      updatedAt = proj.updatedAt;
      for (const node of (proj.items?.nodes ?? []) as RawAny[]) {
        if (items.length >= 50_000) break;
        const contentType =
          node.type === "ISSUE"
            ? "issue"
            : node.type === "PULL_REQUEST"
              ? "pull-request"
              : node.type === "DRAFT_ISSUE"
                ? "draft"
                : "redacted";
        const fieldValues = ((node.fieldValues?.nodes ?? []) as RawAny[])
          .map(mapBoardFieldValue)
          .filter((v): v is WorkspaceBoardFieldValue => v !== null)
          .slice(0, 50);
        items.push({
          itemId: node.id,
          position: position++,
          contentType,
          contentNodeId: node.content?.id ?? null,
          draftTitle: contentType === "draft" ? truncateNullable(node.content?.title, 1024) : null,
          isArchived: Boolean(node.isArchived),
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          fieldValues,
        });
      }
      if (items.length >= 50_000) break;
      const pageInfo: RawPageInfo = proj.items.pageInfo;
      cursor =
        pageInfo.hasNextPage && pageInfo.endCursor && !seen.has(pageInfo.endCursor)
          ? pageInfo.endCursor
          : null;
      if (cursor) seen.add(cursor);
    } while (cursor);

    return {
      board: {
        ...schema,
        owner: boardRef.owner,
        ownerType: boardRef.ownerType,
        number: boardRef.number,
        updatedAt: updatedAt || new Date().toISOString(),
        items,
      },
      cost,
      schemaRefreshed,
    };
  }

  private async readPaginatedRest(basePath: string, signal: AbortSignal): Promise<RawAny[]> {
    const all: RawAny[] = [];
    for (let page = 1; page <= 10; page++) {
      const path =
        page === 1 ? `${basePath}?per_page=100` : `${basePath}?per_page=100&page=${page}`;
      const rows = await this.transport.rest<RawAny[]>(path, signal, 1);
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  }

  async readPullRequestDetail(
    repository: WorkspaceRepository,
    pr: WorkspacePullRequestFacts,
    signal: AbortSignal,
  ): Promise<WorkspacePullRequestDetail> {
    const viewRes = await this.transport.graphql<RawAny>(
      PR_VIEW_QUERY,
      { owner: repository.owner, name: repository.name, number: pr.number },
      signal,
      1,
    );
    const view = viewRes.data.repository?.pullRequest;
    if (!view || view.id !== pr.nodeId)
      throw new WorkspaceGitHubError("Pull request could not be read.", "permission");
    if (
      (pr.headOid && view.headRefOid !== pr.headOid) ||
      (pr.baseOid && view.baseRefOid && view.baseRefOid !== pr.baseOid)
    )
      throw new WorkspaceGitHubError(
        "This pull request changed. Sync before opening its details.",
        "comparison",
      );
    const filesRaw = await this.readPaginatedRest(
      `repos/${repository.owner}/${repository.name}/pulls/${pr.number}/files`,
      signal,
    );
    const reviewsRaw = await this.readPaginatedRest(
      `repos/${repository.owner}/${repository.name}/pulls/${pr.number}/reviews`,
      signal,
    );
    let diff: string;
    try {
      diff = await this.transport.prDiff(repository.owner, repository.name, pr.number, signal, 1);
    } catch (error) {
      if (error instanceof WorkspaceGitHubError && error.diagnostic.status === 406) {
        diff =
          "Diff unavailable: GitHub returned HTTP 406 because this pull request diff exceeds GitHub's size limit.";
      } else {
        throw error;
      }
    }
    return {
      headOid: view.headRefOid,
      body: truncate(typeof view.body === "string" ? view.body : "", 256 * 1024),
      diff: truncate(diff, 2 * 1024 * 1024),
      files: filesRaw.slice(0, 10_000).map((f) => ({
        path: truncate(String(f.filename ?? ""), 4096),
        sha: validOid(f.sha),
        additions: Math.max(0, f.additions ?? 0),
        deletions: Math.max(0, f.deletions ?? 0),
        status: truncate(String(f.status ?? "modified"), 512),
      })),
      reviews: reviewsRaw.slice(0, 10_000).map((r) => ({
        id: truncate(String(r.id), 512),
        author: truncateNullable(r.user?.login, 512),
        state: truncate(String(r.state ?? "COMMENTED"), 512),
        body: truncate(typeof r.body === "string" ? r.body : "", 20_000),
        submittedAt: r.submitted_at ?? null,
        headOid: validOid(r.commit_id),
      })),
      fetchedAt: new Date().toISOString(),
    };
  }

  async readIssueDetail(nodeId: string, signal: AbortSignal): Promise<WorkspaceIssueDetail> {
    const res = await this.transport.graphql<RawAny>(ISSUE_DETAIL_QUERY, { id: nodeId }, signal, 1);
    const node = res.data.node;
    if (!node?.id) throw new WorkspaceGitHubError("Issue could not be read.", "permission");
    return {
      nodeId: node.id,
      body: truncate(typeof node.body === "string" ? node.body : "", 256 * 1024),
      comments: ((node.comments?.nodes ?? []) as RawAny[]).slice(0, 500).map((c) => ({
        id: truncate(String(c.id), 512),
        author: truncateNullable(c.author?.login, 512),
        body: truncate(typeof c.body === "string" ? c.body : "", 20_000),
        createdAt: c.createdAt,
      })),
      timeline: ((node.timelineItems?.nodes ?? []) as RawAny[])
        .slice(0, 500)
        .map(formatTimelineEvent)
        .filter((e): e is NonNullable<typeof e> => e !== null),
      fetchedAt: new Date().toISOString(),
    };
  }
}
