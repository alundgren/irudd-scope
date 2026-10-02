import { Schema } from "effect";
import {
  PullRequestFacts,
  PullRequestStack,
  PullRequestDetail,
  PullRequestsRepository,
} from "@irudd-scope/protocol/pull-requests";
import {
  GitHubProcess,
  GitHubReadError,
  githubFailure,
  githubErrorResponse,
} from "./gh-process.ts";

import { PageInfo, json, validated, githubValue, nextCursor } from "./gh-response.ts";
import {
  GitHubStackMembership,
  enrichStacks,
  readStack,
  summarizeStack,
  type StackObservation,
} from "./gh-stacks.ts";
const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));
const Reviewer = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ login: Schema.String }),
    Schema.Struct({ slug: Schema.String, organization: Schema.Struct({ login: Schema.String }) }),
  ]),
);
const LabelsConnection = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
  pageInfo: PageInfo,
});
const ReviewersConnection = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ requestedReviewer: Reviewer })),
  pageInfo: PageInfo,
});
const CheckRollup = Schema.NullOr(
  Schema.Struct({
    state: Schema.String,
    commit: Schema.Struct({ oid: Schema.String }),
  }),
);
const ReviewDecision = Schema.NullOr(
  Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
);
const OpinionsConnection = Schema.Struct({
  totalCount: Schema.Int,
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      author: Author,
      state: Schema.Literals([
        "APPROVED",
        "CHANGES_REQUESTED",
        "COMMENTED",
        "DISMISSED",
        "PENDING",
      ]),
    }),
  ),
  pageInfo: PageInfo,
});
const ThreadsConnection = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
  pageInfo: PageInfo,
});
const GitHubPullRequest = Schema.Struct({
  state: Schema.String,
  reviewThreads: Schema.optional(ThreadsConnection),
  id: Schema.String,
  repository: Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
  number: Schema.Int,
  title: Schema.String,
  author: Author,
  labels: LabelsConnection,
  reviewRequests: ReviewersConnection,
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefOid: Schema.String,
  stack: Schema.optional(GitHubStackMembership.fields.stack),
  stackEntry: Schema.optional(GitHubStackMembership.fields.stackEntry),
  reviewDecision: Schema.optional(ReviewDecision),
  latestOpinionatedReviews: Schema.optional(OpinionsConnection),
  isDraft: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  url: Schema.String,
  mergeable: Schema.optional(Schema.String),
  updatedAt: Schema.String,
  createdAt: Schema.String,
  commits: Schema.optional(
    Schema.Struct({
      nodes: Schema.Array(
        Schema.Struct({
          commit: Schema.Struct({ oid: Schema.String, statusCheckRollup: CheckRollup }),
        }),
      ),
    }),
  ),
});
const EnrichedGitHubPullRequest = Schema.Struct({
  ...GitHubPullRequest.fields,
  ...GitHubStackMembership.fields,
  reviewDecision: ReviewDecision,
  latestOpinionatedReviews: OpinionsConnection,
});
const StackReviewNode = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  state: Schema.String,
  repository: Schema.Struct({ id: Schema.String }),
  isDraft: Schema.Boolean,
  headRefOid: Schema.String,
  updatedAt: Schema.String,
  ...GitHubStackMembership.fields,
  reviewDecision: ReviewDecision,
  latestOpinionatedReviews: OpinionsConnection,
});
const REVIEW_STACK_FIELDS = `stack { id number size baseRefName } stackEntry { position }
  reviewDecision
  latestOpinionatedReviews(first: 100) { totalCount nodes { id author { login } state } pageInfo { hasNextPage endCursor } }`;
const STACK_REVIEWS_QUERY = `query ScopeStackMemberReviews($ids: [ID!]!) {
  viewer { login } rateLimit { cost limit remaining resetAt }
  nodes(ids: $ids) { ... on PullRequest {
    id number state repository { id } isDraft headRefOid updatedAt ${REVIEW_STACK_FIELDS}
  } }
}`;
const InventoryPage = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.NullOr(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1)),
        owner: Schema.Struct({ login: Schema.String }),
        name: Schema.String,
        nameWithOwner: Schema.String,
        pullRequests: Schema.Struct({ nodes: Schema.Array(GitHubPullRequest), pageInfo: PageInfo }),
      }),
    ),
  }),
});
const ThreadsPage = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            state: Schema.String,
            headRefOid: Schema.String,
            baseRefOid: Schema.String,
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
              pageInfo: PageInfo,
            }),
          }),
        ),
      }),
    ),
  }),
});

const PULL_REQUEST_FIELDS = `${REVIEW_STACK_FIELDS}
 id state repository { id } number title author { login } headRefOid headRefName baseRefOid isDraft
        additions deletions changedFiles url mergeable updatedAt createdAt
        reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
        labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } pageInfo { hasNextPage endCursor } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state commit { oid } } } } }`;
const INVENTORY_QUERY = `query ScopeOpenPullRequests($owner: String!, $name: String!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    pullRequests(states: OPEN, first: 25, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        ${PULL_REQUEST_FIELDS}
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const INITIAL_QUERY = `query ScopeInitialOpenPullRequests($owner: String!, $name: String!, $cursor: String) {
  viewer { login } rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { ${PULL_REQUEST_FIELDS.replace(REVIEW_STACK_FIELDS, "").replace("reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }", "").replace("labels(first: 100)", "labels(first: 25)").replace("reviewRequests(first: 100)", "reviewRequests(first: 25)").replace("commits(last: 1) { nodes { commit { oid statusCheckRollup { state commit { oid } } } } }", "").replace("url mergeable updatedAt", "url updatedAt")} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const ENRICH_QUERY = `query ScopeEnrichPullRequests($ids: [ID!]!) {
  viewer { login } rateLimit { cost limit remaining resetAt }
  nodes(ids: $ids) { ... on PullRequest { ${PULL_REQUEST_FIELDS.replace("repository { id }", "repository { id owner { login } name nameWithOwner }")} } }
}`;
const THREADS_QUERY = `query ScopePullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id state headRefOid baseRefOid
      reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
const LABELS_QUERY = `query ScopePullRequestLabels($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id labels(first: 100, after: $cursor) { nodes { name } pageInfo { hasNextPage endCursor } }
  } }
}`;
const REVIEWERS_QUERY = `query ScopePullRequestReviewers($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } pageInfo { hasNextPage endCursor } }
  } }
}`;
const OPINIONS_QUERY = `query ScopePullRequestOpinions($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login } rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id state headRefOid updatedAt reviewDecision
    latestOpinionatedReviews(first: 100, after: $cursor) { totalCount nodes { id author { login } state } pageInfo { hasNextPage endCursor } }
  } }
}`;
const DetailView = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  body: Schema.String,
});
const Files = Schema.Array(
  Schema.Struct({
    filename: Schema.String,
    additions: Schema.Int,
    deletions: Schema.Int,
    status: Schema.String,
  }),
);
const Reviews = Schema.Array(
  Schema.Struct({
    id: Schema.Int,
    user: Author,
    state: Schema.String,
    body: Schema.String,
    submitted_at: Schema.NullOr(Schema.String),
    commit_id: Schema.NullOr(Schema.String),
  }),
);

function reviewerIdentity(reviewer: typeof Reviewer.Type): string[] {
  if (!reviewer) return [];
  return ["login" in reviewer ? reviewer.login : `${reviewer.organization.login}/${reviewer.slug}`];
}

export interface GitHubReadObservation {
  account: string;
  cost: number;
  limit: number;
  remaining: number;
  resetAt: string;
}
type ReadContext = { account?: string; cost: number; priority: number };
const Observation = Schema.Struct({
  viewer: Schema.Struct({ login: Schema.String }),
  rateLimit: Schema.Struct({
    cost: Schema.Int,
    limit: Schema.Int,
    remaining: Schema.Int,
    resetAt: Schema.String,
  }),
});
let lastObservedAt = 0;
function observedAt() {
  lastObservedAt = Math.max(Date.now(), lastObservedAt + 1);
  return new Date(lastObservedAt).toISOString();
}
const CURRENT_QUERY = `query ScopeCurrentPullRequest($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  rateLimit { cost limit remaining resetAt }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    pullRequest(number: $number) { ${PULL_REQUEST_FIELDS} }
  }
}`;

export class GitHubPullRequests {
  private beforeRead?: (signal: AbortSignal) => Promise<void> | void;
  constructor(
    private readonly process = new GitHubProcess(),
    private observe?: (observation: GitHubReadObservation) => void,
  ) {}

  setReadHooks(
    observe: (observation: GitHubReadObservation) => void,
    beforeRead?: (signal: AbortSignal) => Promise<void> | void,
  ) {
    this.observe = observe;
    this.beforeRead = beforeRead;
  }

  private async query(
    repository: PullRequestsRepository,
    query: string,
    signal: AbortSignal,
    fields: string[] = [],
    context: ReadContext = { cost: 0, priority: 0 },
  ) {
    const { owner, name } = validated(PullRequestsRepository, repository);
    let failure: GitHubReadError | undefined;
    let output: string;
    try {
      output = await this.process.run(
        [
          "api",
          "graphql",
          "--include",
          "--hostname",
          "github.com",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${name}`,
          ...fields,
        ],
        signal,
        context.priority,
        () => this.beforeRead?.(signal),
      );
    } catch (error) {
      if (!(error instanceof GitHubReadError)) throw error;
      const response = githubErrorResponse(error);
      if (response === undefined) throw error;
      output = response;
      failure = error;
    }
    let value: unknown;
    try {
      value = json(output, true);
    } catch (error) {
      throw failure ?? error;
    }
    const errors = (value as { errors?: unknown } | null)?.errors;
    const incomplete = errors !== undefined && (!Array.isArray(errors) || errors.length > 0);
    let data: typeof Observation.Type;
    try {
      data = githubValue(Observation, (value as { data?: unknown } | null)?.data);
    } catch (error) {
      if (failure) throw failure;
      if (incomplete) throw githubFailure(output);
      throw error;
    }
    if (
      !data.viewer.login ||
      data.rateLimit.cost < 0 ||
      data.rateLimit.remaining < 0 ||
      data.rateLimit.limit <= 0 ||
      !Number.isFinite(Date.parse(data.rateLimit.resetAt))
    )
      throw new GitHubReadError(
        "GitHub returned invalid rate limit data. The saved list was kept.",
      );
    const observation = { account: data.viewer.login, ...data.rateLimit };
    this.observe?.(observation);
    if (context.account && context.account !== observation.account)
      throw new GitHubReadError(
        "GitHub CLI account changed during refresh. Try Sync again.",
        "account",
        null,
        {},
        observation.account,
      );
    signal.throwIfAborted();
    context.account = observation.account;
    context.cost += observation.cost;
    if (incomplete)
      throw githubFailure(
        JSON.stringify(errors) +
          "\n" +
          (output.match(/^(?:x-ratelimit-[^\r\n]*|retry-after:[^\r\n]*)/gim)?.join("\n") ?? "") +
          (data.rateLimit.remaining === 0
            ? `\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${Date.parse(data.rateLimit.resetAt) / 1000}`
            : ""),
      );
    if (failure) throw failure;
    return value;
  }

  private async unresolved(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
    first: typeof ThreadsConnection.Type,
    context: ReadContext,
  ): Promise<PullRequestFacts> {
    const seen = new Set<string>();
    let cursor: string | null = nextCursor(first.pageInfo, seen);
    let found = first.nodes.some((thread) => !thread.isResolved);
    let observed = pr;
    try {
      while (cursor) {
        const result = githubValue(
          ThreadsPage,
          await this.query(
            repository,
            THREADS_QUERY,
            signal,
            ["-F", `number=${pr.number}`, "-f", `cursor=${cursor}`],
            context,
          ),
        ).data.repository?.pullRequest;
        if (!result || result.id !== pr.nodeId || result.state !== "OPEN")
          return { ...observed, hasUnresolvedConversations: found ? true : null };
        if (result.headRefOid !== pr.headOid || result.baseRefOid !== pr.baseOid) {
          observed = {
            ...observed,
            merge: { ...pr.merge, status: "unknown" },
            checks:
              result.headRefOid !== pr.headOid
                ? { ...pr.checks, status: "unknown" }
                : observed.checks,
            ...(pr.review && result.headRefOid !== pr.headOid
              ? { review: { ...pr.review, decision: null, hasApproval: null } }
              : {}),
          };
        }
        found ||= result.reviewThreads.nodes.some((thread) => !thread.isResolved);
        cursor = nextCursor(result.reviewThreads.pageInfo, seen);
      }
      return { ...observed, hasUnresolvedConversations: found };
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof GitHubReadError) ||
        ["throttle", "auth", "account"].includes(error.kind)
      )
        throw error;
      return { ...observed, hasUnresolvedConversations: found ? true : null };
    }
  }

  private async metadata(
    repository: PullRequestsRepository,
    node: typeof GitHubPullRequest.Type,
    signal: AbortSignal,
    context: ReadContext,
  ) {
    const labels = node.labels.nodes.map((label) => label.name);
    const requestedReviewers = node.reviewRequests.nodes.flatMap((request) =>
      reviewerIdentity(request.requestedReviewer),
    );
    const LabelsPage = Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({ id: Schema.String, labels: LabelsConnection }),
            ),
          }),
        ),
      }),
    });
    const ReviewersPage = Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({ id: Schema.String, reviewRequests: ReviewersConnection }),
            ),
          }),
        ),
      }),
    });
    const labelCursors = new Set<string>();
    let labelCursor = nextCursor(node.labels.pageInfo, labelCursors);
    while (labelCursor) {
      const result = githubValue(
        LabelsPage,
        await this.query(
          repository,
          LABELS_QUERY,
          signal,
          ["-F", `number=${node.number}`, "-f", `cursor=${labelCursor}`],
          context,
        ),
      ).data.repository?.pullRequest;
      if (!result || result.id !== node.id)
        throw new GitHubReadError("GitHub returned incomplete labels. The saved list was kept.");
      labels.push(...result.labels.nodes.map((label) => label.name));
      labelCursor = nextCursor(result.labels.pageInfo, labelCursors);
    }
    const reviewerCursors = new Set<string>();
    let reviewerCursor = nextCursor(node.reviewRequests.pageInfo, reviewerCursors);
    while (reviewerCursor) {
      const result = githubValue(
        ReviewersPage,
        await this.query(
          repository,
          REVIEWERS_QUERY,
          signal,
          ["-F", `number=${node.number}`, "-f", `cursor=${reviewerCursor}`],
          context,
        ),
      ).data.repository?.pullRequest;
      if (!result || result.id !== node.id)
        throw new GitHubReadError(
          "GitHub returned incomplete review requests. The saved list was kept.",
        );
      requestedReviewers.push(
        ...result.reviewRequests.nodes.flatMap((request) =>
          reviewerIdentity(request.requestedReviewer),
        ),
      );
      reviewerCursor = nextCursor(result.reviewRequests.pageInfo, reviewerCursors);
    }
    return { labels, requestedReviewers };
  }

  private async reviewStatus(
    repository: PullRequestsRepository,
    node: typeof StackReviewNode.Type,
    signal: AbortSignal,
    observedAt: string,
    context: ReadContext,
  ) {
    const Page = Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                state: Schema.String,
                headRefOid: Schema.String,
                updatedAt: Schema.String,
                reviewDecision: ReviewDecision,
                latestOpinionatedReviews: OpinionsConnection,
              }),
            ),
          }),
        ),
      }),
    });
    const ids = new Set<string>(),
      authors = new Set<string>();
    let hasApproval = false;
    function collect(opinions: typeof OpinionsConnection.Type) {
      for (const opinion of opinions.nodes) {
        if (ids.has(opinion.id) || (opinion.author && authors.has(opinion.author.login)))
          throw new GitHubReadError("GitHub review pagination did not advance. Try Sync again.");
        ids.add(opinion.id);
        if (opinion.author) authors.add(opinion.author.login);
        hasApproval ||= opinion.state === "APPROVED";
      }
    }
    collect(node.latestOpinionatedReviews);
    const cursors = new Set<string>();
    let cursor = nextCursor(node.latestOpinionatedReviews.pageInfo, cursors);
    while (cursor) {
      const current = githubValue(
        Page,
        await this.query(
          repository,
          OPINIONS_QUERY,
          signal,
          ["-F", `number=${node.number}`, "-f", `cursor=${cursor}`],
          context,
        ),
      ).data.repository?.pullRequest;
      if (
        !current ||
        current.id !== node.id ||
        current.state !== "OPEN" ||
        current.headRefOid !== node.headRefOid ||
        current.updatedAt !== node.updatedAt ||
        current.reviewDecision !== node.reviewDecision ||
        current.latestOpinionatedReviews.totalCount !== node.latestOpinionatedReviews.totalCount
      )
        throw new GitHubReadError("GitHub reviews changed during refresh. Try Sync again.");
      collect(current.latestOpinionatedReviews);
      cursor = nextCursor(current.latestOpinionatedReviews.pageInfo, cursors);
    }
    if (ids.size !== node.latestOpinionatedReviews.totalCount)
      throw new GitHubReadError("GitHub returned incomplete reviews. Try Sync again.");
    return {
      decision:
        node.reviewDecision === "APPROVED"
          ? ("approved" as const)
          : node.reviewDecision === "CHANGES_REQUESTED"
            ? ("changes-requested" as const)
            : node.reviewDecision === "REVIEW_REQUIRED"
              ? ("review-required" as const)
              : null,
      hasApproval,
      headOid: node.headRefOid,
      observedAt,
    };
  }

  private async facts(
    repository: PullRequestsRepository,
    node: typeof GitHubPullRequest.Type,
    signal: AbortSignal,
    context: ReadContext,
    timestamp: string,
  ): Promise<PullRequestFacts> {
    const review = node.latestOpinionatedReviews
      ? await this.reviewStatus(
          repository,
          githubValue(StackReviewNode, node),
          signal,
          timestamp,
          context,
        )
      : undefined;
    const metadata = await this.metadata(repository, node, signal, context);
    const observedAt = timestamp;
    const rollup = node.commits?.nodes.at(-1)?.commit.statusCheckRollup;
    const status =
      !rollup || rollup.commit.oid !== node.headRefOid
        ? "unknown"
        : rollup.state === "SUCCESS"
          ? "passing"
          : rollup.state === "FAILURE" || rollup.state === "ERROR"
            ? "failing"
            : rollup.state === "PENDING" || rollup.state === "EXPECTED"
              ? "pending"
              : "unknown";

    const facts = validated(PullRequestFacts, {
      nodeId: node.id,
      number: node.number,
      title: node.title,
      author: node.author?.login ?? null,
      ...metadata,
      headOid: node.headRefOid,
      headRefName: node.headRefName,
      baseOid: node.baseRefOid,
      ...(review ? { review } : {}),
      draft: node.isDraft,
      additions: node.additions,
      deletions: node.deletions,
      changedFiles: node.changedFiles,
      url: node.url,
      updatedAt: node.updatedAt,
      createdAt: node.createdAt,
      merge: {
        status:
          node.mergeable === "MERGEABLE"
            ? "clear"
            : node.mergeable === "CONFLICTING"
              ? "conflicting"
              : "unknown",
        headOid: node.headRefOid,
        baseOid: node.baseRefOid,
        observedAt,
      },
      checks: { status, headOid: rollup?.commit.oid ?? null, observedAt },
      hasUnresolvedConversations: null,
    });
    return node.reviewThreads
      ? this.unresolved(repository, facts, signal, node.reviewThreads, context)
      : facts;
  }

  private async currentStack(
    repository: PullRequestsRepository,
    node: typeof EnrichedGitHubPullRequest.Type,
    facts: PullRequestFacts,
    signal: AbortSignal,
    context: ReadContext,
  ): Promise<PullRequestFacts> {
    if (!node.stack) {
      if (node.stackEntry)
        throw new GitHubReadError("GitHub stack membership changed. Try Sync again.");
      return { ...facts, stack: null };
    }
    if (!node.stackEntry)
      throw new GitHubReadError("GitHub stack membership is incomplete. Try Sync again.");
    const entries = await readStack(node.stack, node.repository.id, (query, fields) =>
      this.query(repository, query, signal, fields, context),
    );
    const observations = new Map<string, StackObservation>([[facts.nodeId, facts]]);
    const memberships = new Map<string, typeof GitHubStackMembership.Type>([
      [node.id, { stack: node.stack, stackEntry: node.stackEntry }],
    ]);
    const missing = entries.filter(
      (entry) => entry.pullRequest.state === "OPEN" && entry.pullRequest.id !== node.id,
    );
    const ReviewsPage = Schema.Struct({
      data: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(StackReviewNode)) }),
    });
    for (let offset = 0; offset < missing.length; offset += 25) {
      const batch = missing.slice(offset, offset + 25);
      const result = githubValue(
        ReviewsPage,
        await this.query(
          repository,
          STACK_REVIEWS_QUERY,
          signal,
          batch.flatMap((entry) => ["-f", `ids[]=${entry.pullRequest.id}`]),
          context,
        ),
      ).data.nodes;
      const timestamp = observedAt();
      if (result.length !== batch.length)
        throw new GitHubReadError("GitHub returned incomplete stack reviews. Try Sync again.");
      for (const [index, member] of result.entries()) {
        if (
          !member ||
          member.id !== batch[index]!.pullRequest.id ||
          member.state !== "OPEN" ||
          member.repository.id !== node.repository.id
        )
          throw new GitHubReadError("GitHub stack membership changed. Try Sync again.");
        observations.set(member.id, {
          nodeId: member.id,
          number: member.number,
          headOid: member.headRefOid,
          draft: member.isDraft,
          review: await this.reviewStatus(repository, member, signal, timestamp, context),
        });
        memberships.set(member.id, { stack: member.stack, stackEntry: member.stackEntry });
      }
    }
    const stack = summarizeStack(node.stack, entries, observations, memberships);
    if (!stack.members.some((member) => member.nodeId === node.id && member.state === "open"))
      throw new GitHubReadError("GitHub stack membership changed. Try Sync again.");
    return {
      ...facts,
      stack: validated(PullRequestStack, { ...stack, position: node.stackEntry.position }),
    };
  }

  async current(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
    onClosed?: (observedAt: string) => void,
  ): Promise<PullRequestFacts | null> {
    const context: ReadContext = { cost: 0, priority: 1 };
    const result = await this.query(
      repository,
      CURRENT_QUERY,
      signal,
      ["-F", `number=${pr.number}`],
      context,
    );
    const timestamp = observedAt();
    const CurrentPage = Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            owner: Schema.Struct({ login: Schema.String }),
            name: Schema.String,
            nameWithOwner: Schema.String,
            pullRequest: Schema.NullOr(
              Schema.Struct({
                id: Schema.String,
                state: Schema.String,
                repository: Schema.Struct({ id: Schema.String }),
                number: Schema.Int,
                url: Schema.String,
              }),
            ),
          }),
        ),
      }),
    });
    const resolved = githubValue(CurrentPage, result).data.repository;
    const node = resolved?.pullRequest;
    if (!resolved || !node)
      throw new GitHubReadError(
        "GitHub did not return this pull request. The saved list was kept.",
        "permission",
      );
    const path = `${repository.owner}/${repository.name}`.toLowerCase();
    if (
      node.id !== pr.nodeId ||
      node.number !== pr.number ||
      node.repository.id !== resolved.id ||
      resolved.nameWithOwner.toLowerCase() !== path ||
      `${resolved.owner.login}/${resolved.name}`.toLowerCase() !== path ||
      node.url.toLowerCase() !== `https://github.com/${path}/pull/${pr.number}`
    )
      throw new GitHubReadError("GitHub returned a pull request from another repository.");
    if (node.state === "CLOSED" || node.state === "MERGED") {
      onClosed?.(timestamp);
      return null;
    }
    if (node.state !== "OPEN")
      throw new GitHubReadError("GitHub returned invalid pull request state.");
    const full = githubValue(
      Schema.Struct({
        data: Schema.Struct({
          repository: Schema.Struct({ pullRequest: EnrichedGitHubPullRequest }),
        }),
      }),
      result,
    ).data.repository.pullRequest;
    const facts = await this.facts(repository, full, signal, context, timestamp);
    return this.currentStack(repository, full, facts, signal, context);
  }

  async account(signal: AbortSignal): Promise<string> {
    const output = await this.process.run(
      ["api", "--hostname", "github.com", "--include", "user"],
      signal,
      2,
    );
    return githubValue(
      Schema.Struct({ login: Schema.String.check(Schema.isMinLength(1)) }),
      json(output),
    ).login;
  }

  private async run(args: string[], signal: AbortSignal) {
    return this.process.run(args, signal, 1, () => this.beforeRead?.(signal));
  }

  inventory(repository: PullRequestsRepository, signal: AbortSignal) {
    return this.readInventory(repository, signal, INVENTORY_QUERY);
  }

  initialInventory(repository: PullRequestsRepository, signal: AbortSignal) {
    return this.readInventory(repository, signal, INITIAL_QUERY);
  }

  async enrichInventory(
    repository: PullRequestsRepository,
    prs: readonly PullRequestFacts[],
    signal: AbortSignal,
  ) {
    const queriedRepository = validated(PullRequestsRepository, repository);
    const context: ReadContext = { cost: 0, priority: 0 };
    const enriched: PullRequestFacts[] = [];
    const memberships = new Map<string, typeof GitHubStackMembership.Type>();
    const closed = new Map<string, string>();
    let startedAt: string | undefined;
    let repositoryId: string | undefined;
    const inputIds = new Set<string>();
    for (const pr of prs) {
      validated(PullRequestFacts, pr);
      if (inputIds.has(pr.nodeId))
        throw new GitHubReadError("GitHub enrichment contains duplicate pull requests.");
      inputIds.add(pr.nodeId);
    }
    const EnrichmentPage = Schema.Struct({
      data: Schema.Struct({
        nodes: Schema.Array(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              state: Schema.String,
              number: Schema.Int,
              url: Schema.String,
              repository: Schema.Struct({
                id: Schema.String,
                owner: Schema.Struct({ login: Schema.String }),
                name: Schema.String,
                nameWithOwner: Schema.String,
              }),
            }),
          ),
        ),
      }),
    });
    for (let offset = 0; offset < Math.max(prs.length, 1); offset += 25) {
      const batch = prs.slice(offset, offset + 25);
      const result = await this.query(
        repository,
        ENRICH_QUERY,
        signal,
        batch.length ? batch.flatMap((pr) => ["-f", `ids[]=${pr.nodeId}`]) : ["-F", "ids[]"],
        context,
      );
      const timestamp = observedAt();
      startedAt ??= timestamp;
      const nodes = githubValue(EnrichmentPage, result).data.nodes;
      if (nodes.length !== batch.length)
        throw new GitHubReadError("GitHub did not return complete pull request enrichment.");
      for (const [index, node] of nodes.entries()) {
        const requested = batch[index];
        if (!node)
          throw new GitHubReadError(
            "GitHub did not return this pull request. The saved list was kept.",
            "permission",
          );
        const path = `${repository.owner}/${repository.name}`.toLowerCase();
        if (
          node.id !== requested.nodeId ||
          node.number !== requested.number ||
          node.url.toLowerCase() !== `https://github.com/${path}/pull/${node.number}` ||
          node.repository.nameWithOwner.toLowerCase() !== path ||
          `${node.repository.owner.login}/${node.repository.name}`.toLowerCase() !== path ||
          (repositoryId && node.repository.id !== repositoryId)
        )
          throw new GitHubReadError("GitHub returned a pull request from another repository.");
        repositoryId = node.repository.id;
        if (node.state === "CLOSED" || node.state === "MERGED") {
          closed.set(node.id, timestamp);
          continue;
        }
        if (node.state !== "OPEN")
          throw new GitHubReadError("GitHub returned invalid pull request state.");
        const raw = (result as { data: { nodes: unknown[] } }).data.nodes[index];
        const full = githubValue(EnrichedGitHubPullRequest, raw);
        memberships.set(full.id, { stack: full.stack, stackEntry: full.stackEntry });
        if (!full.reviewThreads)
          throw new GitHubReadError("GitHub returned incomplete conversation data.");
        enriched.push(await this.facts(repository, full, signal, context, timestamp));
      }
    }
    const stackEnriched = await enrichStacks(
      enriched,
      memberships,
      repositoryId!,
      (query, fields) => this.query(repository, query, signal, fields, context),
    );
    return {
      queriedRepository,
      repository: queriedRepository,
      viewer: context.account!,
      account: context.account!,
      cost: context.cost,
      startedAt: startedAt!,
      prs: stackEnriched,
      closed,
    };
  }

  private async readInventory(
    repository: PullRequestsRepository,
    signal: AbortSignal,
    inventoryQuery: string,
  ): Promise<{
    queriedRepository: PullRequestsRepository;
    repository: PullRequestsRepository;
    viewer: string;
    prs: PullRequestFacts[];
    account: string;
    cost: number;
    startedAt: string;
  }> {
    const context: ReadContext = { cost: 0, priority: 0 };
    const queriedRepository = validated(PullRequestsRepository, repository);
    let startedAt: string | undefined;
    let cursor: string | null = null;
    const seen = new Set<string>();
    const prs: PullRequestFacts[] = [];
    const ids = new Set<string>();
    const numbers = new Set<number>();
    const memberships = new Map<string, typeof GitHubStackMembership.Type>();
    let viewer: string | undefined;
    let repositoryId: string | undefined;
    let resolvedRepository: PullRequestsRepository | undefined;
    do {
      const page = githubValue(
        InventoryPage,
        await this.query(
          repository,
          inventoryQuery,
          signal,
          cursor ? ["-f", `cursor=${cursor}`] : [],
          context,
        ),
      ).data;
      const timestamp = observedAt();
      startedAt ??= timestamp;
      if (!page.repository)
        throw new GitHubReadError(
          "Your GitHub CLI account cannot read this repository.",
          "permission",
        );
      const resolved = validated(PullRequestsRepository, {
        owner: page.repository.owner.login,
        name: page.repository.name,
      });
      const canonicalPath = `${resolved.owner}/${resolved.name}`.toLowerCase();
      if (
        page.repository.nameWithOwner.toLowerCase() !== canonicalPath ||
        (repositoryId && repositoryId !== page.repository.id) ||
        (resolvedRepository &&
          `${resolvedRepository.owner}/${resolvedRepository.name}`.toLowerCase() !== canonicalPath)
      )
        throw new GitHubReadError(
          "GitHub repository identity changed during refresh. Try Sync again.",
        );
      repositoryId = page.repository.id;
      resolvedRepository = resolved;
      if (viewer && viewer !== page.viewer.login)
        throw new GitHubReadError("GitHub CLI account changed during refresh. Try Sync again.");
      viewer = page.viewer.login;
      for (const node of page.repository.pullRequests.nodes) {
        if (node.state !== "OPEN")
          throw new GitHubReadError("GitHub returned a closed pull request in the open inventory.");
        if (
          node.repository.id !== repositoryId ||
          node.url.toLowerCase() !== `https://github.com/${canonicalPath}/pull/${node.number}`
        )
          throw new GitHubReadError("GitHub returned a pull request from another repository.");
        if (ids.has(node.id) || numbers.has(node.number))
          throw new GitHubReadError("GitHub returned duplicate pull requests. Try Sync again.");
        ids.add(node.id);
        numbers.add(node.number);
        if (inventoryQuery !== INITIAL_QUERY)
          memberships.set(node.id, githubValue(GitHubStackMembership, node));
        prs.push(
          await this.facts(
            repository,
            inventoryQuery === INITIAL_QUERY
              ? {
                  ...node,
                  reviewThreads: undefined,
                  commits: undefined,
                  mergeable: undefined,
                  stack: undefined,
                  stackEntry: undefined,
                  reviewDecision: undefined,
                  latestOpinionatedReviews: undefined,
                }
              : githubValue(EnrichedGitHubPullRequest, node),
            signal,
            context,
            timestamp,
          ),
        );
      }
      cursor = nextCursor(page.repository.pullRequests.pageInfo, seen);
    } while (cursor);
    return {
      queriedRepository,
      repository: resolvedRepository!,
      viewer: viewer!,
      prs:
        inventoryQuery === INITIAL_QUERY
          ? prs
          : await enrichStacks(prs, memberships, repositoryId!, (query, fields) =>
              this.query(repository, query, signal, fields, context),
            ),
      account: context.account!,
      cost: context.cost,
      startedAt: startedAt!,
    };
  }

  private async view(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
    context: ReadContext,
  ) {
    const result = await this.query(
      repository,
      `query ScopePullRequestReviewBody($owner: String!, $name: String!, $number: Int!) {
      viewer { login } rateLimit { cost limit remaining resetAt }
      repository(owner: $owner, name: $name) { nameWithOwner pullRequest(number: $number) { id state headRefOid baseRefOid body } }
    }`,
      signal,
      ["-F", `number=${pr.number}`],
      context,
    );
    const page = githubValue(
      Schema.Struct({
        data: Schema.Struct({
          repository: Schema.NullOr(
            Schema.Struct({ nameWithOwner: Schema.String, pullRequest: Schema.NullOr(DetailView) }),
          ),
        }),
      }),
      result,
    );
    const resolved = page.data.repository;
    const view = resolved?.pullRequest;
    if (
      resolved &&
      resolved.nameWithOwner.toLowerCase() !==
        `${repository.owner}/${repository.name}`.toLowerCase()
    )
      throw new GitHubReadError("GitHub returned a pull request from another repository.");
    if (!view) throw new GitHubReadError("GitHub did not return this pull request.", "permission");
    return view;
  }

  private async reviewPages(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
  ) {
    const { owner, name } = validated(PullRequestsRepository, repository);
    const reviews: PullRequestDetail["reviews"][number][] = [];
    const reviewIds = new Set<number>();
    for (let page = 1; ; page++) {
      const result = githubValue(
        Reviews,
        json(
          await this.run(
            [
              "api",
              "--include",
              "--hostname",
              "github.com",
              "--method",
              "GET",
              `repos/${owner}/${name}/pulls/${pr.number}/reviews?per_page=100&page=${page}`,
            ],
            signal,
          ),
        ),
      );
      reviews.push(
        ...result.map((review) => ({
          id: String(review.id),
          author: review.user?.login ?? null,
          state: review.state,
          body: review.body,
          submittedAt: review.submitted_at,
          headOid: review.commit_id,
        })),
      );
      for (const review of result) {
        if (reviewIds.has(review.id))
          throw new GitHubReadError("GitHub review pagination did not advance. Try again.");
        reviewIds.add(review.id);
      }
      if (result.length < 100) break;
    }
    return reviews;
  }

  async reviews(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
  ): Promise<Pick<PullRequestDetail, "body" | "reviews" | "fetchedAt">> {
    const context: ReadContext = { cost: 0, priority: 1 };
    const before = await this.view(repository, pr, signal, context);
    if (before.id !== pr.nodeId || before.state !== "OPEN")
      throw new GitHubReadError("This pull request changed. Sync before opening its details.");
    const reviews = await this.reviewPages(repository, pr, signal);
    const after = await this.view(repository, pr, signal, context);
    if (after.id !== before.id || after.state !== "OPEN")
      throw new GitHubReadError("This pull request changed while loading. Sync and open it again.");
    return { body: after.body, reviews, fetchedAt: observedAt() };
  }

  async detail(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
  ): Promise<PullRequestDetail> {
    const { owner, name } = validated(PullRequestsRepository, repository);
    const context: ReadContext = { cost: 0, priority: 1 };
    const before = await this.view(repository, pr, signal, context);
    if (
      before.id !== pr.nodeId ||
      before.state !== "OPEN" ||
      before.headRefOid !== pr.headOid ||
      before.baseRefOid !== pr.baseOid
    )
      throw new GitHubReadError("This pull request changed. Sync before opening its details.");
    const files: PullRequestDetail["files"][number][] = [];
    const reviews: PullRequestDetail["reviews"][number][] = [];
    const filePaths = new Set<string>();
    for (let page = 1; ; page++) {
      const result = githubValue(
        Files,
        json(
          await this.run(
            [
              "api",
              "--include",
              "--hostname",
              "github.com",
              "--method",
              "GET",
              `repos/${owner}/${name}/pulls/${pr.number}/files?per_page=100&page=${page}`,
            ],
            signal,
          ),
        ),
      );
      files.push(
        ...result.map((file) => ({
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          status: file.status,
        })),
      );
      for (const file of result) {
        if (filePaths.has(file.filename))
          throw new GitHubReadError("GitHub file pagination did not advance. Try again.");
        filePaths.add(file.filename);
      }
      if (result.length < 100) break;
    }
    if (files.length !== pr.changedFiles)
      throw new GitHubReadError("GitHub did not return all changed files. Sync and try again.");
    reviews.push(...(await this.reviewPages(repository, pr, signal)));
    const diff = await this.run(
      [
        "pr",
        "diff",
        String(pr.number),
        "--repo",
        `github.com/${owner}/${name}`,
        "--color",
        "never",
      ],
      signal,
    );
    const after = await this.view(repository, pr, signal, context);
    if (
      after.id !== before.id ||
      after.state !== "OPEN" ||
      after.headRefOid !== before.headRefOid ||
      after.baseRefOid !== before.baseRefOid
    )
      throw new GitHubReadError("This pull request changed while loading. Sync and open it again.");
    return validated(PullRequestDetail, {
      headOid: before.headRefOid,
      body: before.body,
      files,
      reviews,
      diff,
      fetchedAt: new Date().toISOString(),
    });
  }
}
