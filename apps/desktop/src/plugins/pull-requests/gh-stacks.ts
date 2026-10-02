import { Schema } from "effect";
import { PullRequestStack, type PullRequestFacts } from "@irudd-scope/protocol/pull-requests";
import { GitHubReadError } from "./gh-process.ts";
import { PageInfo, githubValue, nextCursor, validated } from "./gh-response.ts";

const Header = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  size: Schema.Int,
  baseRefName: Schema.String,
});
export const GitHubStackMembership = Schema.Struct({
  stack: Schema.NullOr(Header),
  stackEntry: Schema.NullOr(Schema.Struct({ position: Schema.Int })),
});
type Membership = typeof GitHubStackMembership.Type;
const Entry = Schema.Struct({
  position: Schema.Int,
  pullRequest: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      number: Schema.Int,
      repository: Schema.Struct({ id: Schema.String }),
      state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
      isDraft: Schema.Boolean,
      headRefOid: Schema.String,
    }),
  ),
});
const Page = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        ...Header.fields,
        entries: Schema.Struct({
          totalCount: Schema.Int,
          nodes: Schema.Array(Schema.NullOr(Entry)),
          pageInfo: PageInfo,
        }),
      }),
    ),
  }),
});
const QUERY = `query ScopePullRequestStack($id: ID!, $cursor: String) {
  viewer { login } rateLimit { cost limit remaining resetAt }
  node(id: $id) { ... on PullRequestStack {
    id number size baseRefName
    entries(first: 100, after: $cursor) {
      totalCount
      nodes { position pullRequest { id number repository { id } state isDraft headRefOid } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;
const changed = () =>
  new GitHubReadError("GitHub stack membership changed or is incomplete. Try Sync again.");

export async function readStack(
  header: typeof Header.Type,
  repositoryId: string,
  query: (query: string, fields: string[]) => Promise<unknown>,
) {
  let cursor: string | null = null;
  const cursors = new Set<string>(),
    ids = new Set<string>(),
    positions = new Set<number>();
  const entries: (typeof Entry.Type & {
    pullRequest: NonNullable<(typeof Entry.Type)["pullRequest"]>;
  })[] = [];
  do {
    const page = githubValue(
      Page,
      await query(QUERY, ["-f", `id=${header.id}`, ...(cursor ? ["-f", `cursor=${cursor}`] : [])]),
    ).data.node;
    if (
      !page ||
      page.id !== header.id ||
      page.number !== header.number ||
      page.size !== header.size ||
      page.baseRefName !== header.baseRefName ||
      page.entries.totalCount !== header.size
    )
      throw changed();
    for (const entry of page.entries.nodes) {
      if (
        !entry?.pullRequest ||
        entry.pullRequest.repository.id !== repositoryId ||
        ids.has(entry.pullRequest.id) ||
        positions.has(entry.position)
      )
        throw changed();
      ids.add(entry.pullRequest.id);
      positions.add(entry.position);
      entries.push({ ...entry, pullRequest: entry.pullRequest });
    }
    cursor = nextCursor(page.entries.pageInfo, cursors);
  } while (cursor);
  if (entries.length !== header.size) throw changed();
  return entries.sort((a, b) => a.position - b.position);
}

export type StackObservation = Pick<
  PullRequestFacts,
  "nodeId" | "number" | "draft" | "headOid" | "review"
>;

export function summarizeStack(
  header: NonNullable<Membership["stack"]>,
  entries: Awaited<ReturnType<typeof readStack>>,
  byId: ReadonlyMap<string, StackObservation>,
  memberships: ReadonlyMap<string, Membership>,
): Omit<PullRequestStack, "position"> {
  const open: StackObservation[] = [];
  for (const entry of entries) {
    const member = entry.pullRequest;
    const current = byId.get(member.id);
    if (member.state !== "OPEN") {
      if (current) throw changed();
      continue;
    }
    const expected = memberships.get(member.id);
    if (
      !current ||
      current.number !== member.number ||
      current.draft !== member.isDraft ||
      current.headOid !== member.headRefOid ||
      expected?.stack?.id !== header.id ||
      expected.stack.number !== header.number ||
      expected.stack.size !== header.size ||
      expected.stack.baseRefName !== header.baseRefName ||
      expected.stackEntry?.position !== entry.position
    )
      throw changed();
    open.push(current);
  }
  if (!open.length) throw changed();
  return {
    nodeId: header.id,
    number: header.number,
    size: header.size,
    baseRefName: header.baseRefName,
    members: entries.map(({ position, pullRequest: member }) => ({
      nodeId: member.id,
      number: member.number,
      position,
      state: member.state === "OPEN" ? "open" : member.state === "MERGED" ? "merged" : "closed",
      draft: member.isDraft,
    })),
    readyForReview: open.every((member) => !member.draft),
    approved: open.some((member) => member.review?.hasApproval === false)
      ? false
      : open.every((member) => member.review?.hasApproval === true)
        ? true
        : null,
    observedAt: new Date().toISOString(),
  };
}

export async function enrichStacks(
  prs: readonly PullRequestFacts[],
  memberships: ReadonlyMap<string, Membership>,
  repositoryId: string,
  query: (query: string, fields: string[]) => Promise<unknown>,
): Promise<PullRequestFacts[]> {
  const byId = new Map(prs.map((pr) => [pr.nodeId, pr]));
  const stacks = new Map<string, Omit<PullRequestStack, "position">>();
  for (const pr of prs) {
    const membership = memberships.get(pr.nodeId)!;
    if (!membership.stack) {
      if (membership.stackEntry) throw changed();
      continue;
    }
    if (!membership.stackEntry) throw changed();
    const header = membership.stack;
    if (stacks.has(header.id)) continue;
    const entries = await readStack(header, repositoryId, query);
    stacks.set(header.id, summarizeStack(header, entries, byId, memberships));
  }
  return prs.map((pr) => {
    const membership = memberships.get(pr.nodeId)!;
    if (!membership.stack) return { ...pr, stack: null };
    const stack = stacks.get(membership.stack.id)!;
    if (!stack.members.some((member) => member.nodeId === pr.nodeId && member.state === "open"))
      throw changed();
    return {
      ...pr,
      stack: validated(PullRequestStack, { ...stack, position: membership.stackEntry!.position }),
    };
  });
}
