import { Schema } from "effect";
import { PublicationTabId } from "@irudd-scope/protocol";
import {
  PullRequestCommitPair,
  PullRequestNodeId,
  PullRequestDetail,
} from "@irudd-scope/protocol/pull-requests";

const CapturedDetail = Schema.Struct({
  nodeId: PullRequestNodeId,
  ...PullRequestCommitPair.fields,
});
export const PullRequestsCancelReads = Schema.Struct({
  tabId: PublicationTabId,
  requestIds: Schema.Array(PublicationTabId).check(Schema.isMaxLength(1000)),
});
export type PullRequestsCancelReads = typeof PullRequestsCancelReads.Type;
export const PullRequestsInterest = Schema.Struct({
  tabId: PublicationTabId,
  active: Schema.Boolean,
  refresh: Schema.optional(Schema.Boolean),
  detail: Schema.optional(Schema.NullOr(CapturedDetail)),
  details: Schema.optional(Schema.Array(CapturedDetail).check(Schema.isMaxLength(1000))),
});
export type PullRequestsInterest = typeof PullRequestsInterest.Type;
export const PullRequestsDetailUpdate = Schema.Struct({
  tabId: PublicationTabId,
  nodeId: PullRequestNodeId,
  ...PullRequestCommitPair.fields,
  body: Schema.optional(PullRequestDetail.fields.body),
  reviews: Schema.optional(PullRequestDetail.fields.reviews),
  fetchedAt: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type PullRequestsDetailUpdate = typeof PullRequestsDetailUpdate.Type;
