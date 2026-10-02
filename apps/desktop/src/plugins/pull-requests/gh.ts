import { Schema } from "effect";
import {
  PullRequestFacts,
  PullRequestDetail,
  PullRequestsRepository,
} from "@irudd-scope/protocol/pull-requests";
import { GitHubProcess, GitHubReadError } from "./gh-process.ts";

import { PageInfo, json, validated, githubValue, nextCursor } from "./gh-response.ts";
import { GitHubStackMembership, enrichStacks } from "./gh-stacks.ts";
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
const GitHubPullRequest = Schema.Struct({
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
  ...GitHubStackMembership.fields,
  reviewDecision: ReviewDecision,
  latestOpinionatedReviews: OpinionsConnection,
  isDraft: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  url: Schema.String,
  mergeable: Schema.String,
  updatedAt: Schema.String,
  createdAt: Schema.String,
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({ oid: Schema.String, statusCheckRollup: CheckRollup }),
      }),
    ),
  }),
});
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

const INVENTORY_QUERY = `query ScopeOpenPullRequests($owner: String!, $name: String!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    id owner { login } name nameWithOwner
    pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        id repository { id } number title author { login } headRefOid headRefName baseRefOid isDraft
        stack { id number size baseRefName } stackEntry { position }
        reviewDecision
        latestOpinionatedReviews(first: 100) { totalCount nodes { id author { login } state } pageInfo { hasNextPage endCursor } }
        additions deletions changedFiles url mergeable updatedAt createdAt
        labels(first: 100) { nodes { name } pageInfo { hasNextPage endCursor } }
        reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } pageInfo { hasNextPage endCursor } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state commit { oid } } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const THREADS_QUERY = `query ScopePullRequestThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id state headRefOid baseRefOid
      reviewThreads(first: 100, after: $cursor) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
    }
  }
}`;
const LABELS_QUERY = `query ScopePullRequestLabels($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id labels(first: 100, after: $cursor) { nodes { name } pageInfo { hasNextPage endCursor } }
  } }
}`;
const REVIEWERS_QUERY = `query ScopePullRequestReviewers($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id reviewRequests(first: 100, after: $cursor) { nodes { requestedReviewer { ... on User { login } ... on Team { slug organization { login } } } } pageInfo { hasNextPage endCursor } }
  } }
}`;
const OPINIONS_QUERY = `query ScopePullRequestOpinions($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id state headRefOid updatedAt reviewDecision
    latestOpinionatedReviews(first: 100, after: $cursor) { totalCount nodes { id author { login } state } pageInfo { hasNextPage endCursor } }
  } }
}`;
const DetailView = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  headRefOid: Schema.String,
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

export class GitHubPullRequests {
  constructor(private readonly process = new GitHubProcess()) {}

  private async query(
    repository: PullRequestsRepository,
    query: string,
    signal: AbortSignal,
    fields: string[] = [],
  ) {
    const { owner, name } = validated(PullRequestsRepository, repository);
    return json(
      await this.process.run(
        [
          "api",
          "graphql",
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
      ),
    );
  }

  private async unresolved(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
  ): Promise<PullRequestFacts> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let found = false;
    let observed = pr;
    try {
      do {
        const result = githubValue(
          ThreadsPage,
          await this.query(repository, THREADS_QUERY, signal, [
            "-F",
            `number=${pr.number}`,
            ...(cursor ? ["-f", `cursor=${cursor}`] : []),
          ]),
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
            review:
              pr.review && result.headRefOid !== pr.headOid
                ? { ...pr.review, decision: null, hasApproval: null }
                : observed.review,
          };
        }
        found ||= result.reviewThreads.nodes.some((thread) => !thread.isResolved);
        cursor = nextCursor(result.reviewThreads.pageInfo, seen);
      } while (cursor);
      return { ...observed, hasUnresolvedConversations: found };
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof GitHubReadError)) throw error;
      return { ...observed, hasUnresolvedConversations: found ? true : null };
    }
  }

  private async metadata(
    repository: PullRequestsRepository,
    node: typeof GitHubPullRequest.Type,
    signal: AbortSignal,
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
        await this.query(repository, LABELS_QUERY, signal, [
          "-F",
          `number=${node.number}`,
          "-f",
          `cursor=${labelCursor}`,
        ]),
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
        await this.query(repository, REVIEWERS_QUERY, signal, [
          "-F",
          `number=${node.number}`,
          "-f",
          `cursor=${reviewerCursor}`,
        ]),
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
    node: typeof GitHubPullRequest.Type,
    signal: AbortSignal,
    observedAt: string,
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
        await this.query(repository, OPINIONS_QUERY, signal, [
          "-F",
          `number=${node.number}`,
          "-f",
          `cursor=${cursor}`,
        ]),
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

  async inventory(
    repository: PullRequestsRepository,
    signal: AbortSignal,
  ): Promise<{
    queriedRepository: PullRequestsRepository;
    repository: PullRequestsRepository;
    viewer: string;
    prs: PullRequestFacts[];
  }> {
    const queriedRepository = validated(PullRequestsRepository, repository);
    let cursor: string | null = null;
    const seen = new Set<string>();
    const prs: PullRequestFacts[] = [];
    const ids = new Set<string>();
    const memberships = new Map<string, typeof GitHubStackMembership.Type>();
    let viewer: string | undefined;
    let repositoryId: string | undefined;
    let resolvedRepository: PullRequestsRepository | undefined;
    do {
      const page = githubValue(
        InventoryPage,
        await this.query(
          repository,
          INVENTORY_QUERY,
          signal,
          cursor ? ["-f", `cursor=${cursor}`] : [],
        ),
      ).data;
      const observedAt = new Date().toISOString();
      if (!page.repository)
        throw new GitHubReadError("Your GitHub CLI account cannot read this repository.");
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
        if (
          node.repository.id !== repositoryId ||
          node.url.toLowerCase() !== `https://github.com/${canonicalPath}/pull/${node.number}`
        )
          throw new GitHubReadError("GitHub returned a pull request from another repository.");
        if (ids.has(node.id))
          throw new GitHubReadError("GitHub returned duplicate pull requests. Try Sync again.");
        ids.add(node.id);
        memberships.set(node.id, { stack: node.stack, stackEntry: node.stackEntry });
        const metadata = await this.metadata(repository, node, signal);
        const review = await this.reviewStatus(repository, node, signal, observedAt);
        const rollup = node.commits.nodes.at(-1)?.commit.statusCheckRollup;
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
        prs.push(
          validated(PullRequestFacts, {
            nodeId: node.id,
            number: node.number,
            title: node.title,
            author: node.author?.login ?? null,
            ...metadata,
            headOid: node.headRefOid,
            headRefName: node.headRefName,
            baseOid: node.baseRefOid,
            review,
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
          }),
        );
      }
      cursor = nextCursor(page.repository.pullRequests.pageInfo, seen);
    } while (cursor);
    const observed: PullRequestFacts[] = [];
    for (const pr of prs) observed.push(await this.unresolved(repository, pr, signal));
    const enriched = await enrichStacks(observed, memberships, repositoryId!, (query, fields) =>
      this.query(repository, query, signal, fields),
    );
    return { queriedRepository, repository: resolvedRepository!, viewer: viewer!, prs: enriched };
  }

  async detail(
    repository: PullRequestsRepository,
    pr: PullRequestFacts,
    signal: AbortSignal,
  ): Promise<PullRequestDetail> {
    const { owner, name } = validated(PullRequestsRepository, repository);
    const viewArgs = [
      "pr",
      "view",
      String(pr.number),
      "--repo",
      `github.com/${owner}/${name}`,
      "--json",
      "id,state,headRefOid,body",
    ];
    const before = githubValue(DetailView, json(await this.process.run(viewArgs, signal)));
    if (before.id !== pr.nodeId || before.state !== "OPEN" || before.headRefOid !== pr.headOid)
      throw new GitHubReadError("This pull request changed. Sync before opening its details.");
    const files: PullRequestDetail["files"][number][] = [];
    const reviews: PullRequestDetail["reviews"][number][] = [];
    const filePaths = new Set<string>();
    for (let page = 1; ; page++) {
      const result = githubValue(
        Files,
        json(
          await this.process.run(
            [
              "api",
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
    const reviewIds = new Set<number>();
    for (let page = 1; ; page++) {
      const result = githubValue(
        Reviews,
        json(
          await this.process.run(
            [
              "api",
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
    const diff = await this.process.run(
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
    const after = githubValue(DetailView, json(await this.process.run(viewArgs, signal)));
    if (after.id !== before.id || after.state !== "OPEN" || after.headRefOid !== before.headRefOid)
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
