import { Schema } from "effect";
import { PublicationTabId } from "@irudd-scope/protocol";
import {
  PullRequestCommit,
  PullRequestNodeId,
  PullRequestDetail,
} from "@irudd-scope/protocol/pull-requests";

export const PullRequestsInterest = Schema.Struct({
  tabId: PublicationTabId,
  active: Schema.Boolean,
  detail: Schema.NullOr(
    Schema.Struct({
      nodeId: PullRequestNodeId,
      headOid: PullRequestCommit,
      baseOid: PullRequestCommit,
    }),
  ),
});
export type PullRequestsInterest = typeof PullRequestsInterest.Type;
export const PullRequestsDetailUpdate = Schema.Struct({
  tabId: PublicationTabId,
  nodeId: PullRequestNodeId,
  headOid: PullRequestCommit,
  baseOid: PullRequestCommit,
  body: Schema.optional(PullRequestDetail.fields.body),
  reviews: Schema.optional(PullRequestDetail.fields.reviews),
  fetchedAt: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type PullRequestsDetailUpdate = typeof PullRequestsDetailUpdate.Type;
