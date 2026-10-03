export type Actor = { id: string; name: string; kind: "human" | "agent" };

export type CommentAnchor = {
  elementId: string | null;
  quote: string;
  x: number;
  y: number;
};

export type CommentReply = { id: string; text: string; actor: Actor; createdAt: string };
export type PlanComment = {
  id: string;
  anchor: CommentAnchor;
  text: string;
  actor: Actor;
  createdAt: string;
  resolved: boolean;
  replies: CommentReply[];
};

export type PlanSnapshot = {
  name: string;
  revision: number;
  htmlRevision: number;
  html: string;
  comments: PlanComment[];
  updatedAt: string;
};

type CommandIdentity = { requestId: string; actor: Actor };
export type HtmlCommand = CommandIdentity & {
  kind: "html";
  baseHtmlRevision: number;
  html: string;
};
export type PlanCommand =
  | HtmlCommand
  | (CommandIdentity & { kind: "comment.add"; anchor: CommentAnchor; text: string })
  | (CommandIdentity & { kind: "comment.reply"; commentId: string; text: string })
  | (CommandIdentity & { kind: "comment.resolve"; commentId: string; resolved: boolean });

export type CommandReceipt = {
  requestId: string;
  revision: number;
  rebased: boolean;
  snapshot: PlanSnapshot;
};
export type ConflictReceipt = {
  error: "conflict";
  message: string;
  requestId: string;
  snapshot: PlanSnapshot;
};

export type PlanEvent = {
  revision: number;
  htmlRevision: number;
  requestId: string;
  kind: PlanCommand["kind"] | "created";
  actor: Actor;
  createdAt: string;
  diff: string;
  snapshot: PlanSnapshot;
};
export type VersionPage = { versions: PlanEvent[]; nextBefore: number | null };

export type Presence = {
  sessionId: string;
  actor: Actor;
  elementId: string | null;
  x: number;
  y: number;
  updatedAt: number;
};

export function planApi(name: string) {
  return `/api/plans/${encodeURIComponent(name)}`;
}

export type PlanSubscription = { name: string; after: number };
export type PlanStreamPresence = { name: string; people: Presence[] };
export const planStreamLimits = {
  subscriptions: 20,
  encodedQueryLength: 4096,
  requestLength: 8192,
};

export function planEventsUrl(subscriptions: PlanSubscription[]) {
  const encoded = encodeURIComponent(JSON.stringify(subscriptions));
  if (!subscriptions.length || subscriptions.length > planStreamLimits.subscriptions)
    throw new Error(`Subscribe to between 1 and ${planStreamLimits.subscriptions} plans.`);
  if (encoded.length > planStreamLimits.encodedQueryLength)
    throw new Error("Plan subscriptions exceed the event stream URL limit.");
  return `/api/events?subscriptions=${encoded}`;
}
