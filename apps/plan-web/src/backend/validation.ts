import type { Actor, CommentAnchor, PlanCommand, Presence } from "../contracts.ts";

export class InvalidInput extends Error {}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidInput("Expected an object.");
  return input as Record<string, unknown>;
}
function string(input: unknown, empty = false): string {
  if (typeof input !== "string" || (!empty && !input.length))
    throw new InvalidInput("Expected a string.");
  if (!input.isWellFormed()) throw new InvalidInput("Text must contain valid Unicode.");
  return input;
}
function number(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input))
    throw new InvalidInput("Expected a finite number.");
  return input;
}
function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") throw new InvalidInput("Expected a boolean.");
  return input;
}
function elementId(input: unknown): string | null {
  return input === null ? null : string(input);
}
function actor(input: unknown): Actor {
  const value = object(input);
  if (value.kind !== "human" && value.kind !== "agent")
    throw new InvalidInput("Unknown actor kind.");
  return { id: string(value.id), name: string(value.name), kind: value.kind };
}
function anchor(input: unknown): CommentAnchor {
  const value = object(input);
  return {
    elementId: elementId(value.elementId),
    quote: string(value.quote, true),
    x: number(value.x),
    y: number(value.y),
  };
}
export function parseCommand(input: unknown): PlanCommand {
  const value = object(input);
  const identity = { requestId: string(value.requestId), actor: actor(value.actor) };
  switch (value.kind) {
    case "html": {
      const revision = number(value.baseHtmlRevision);
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new InvalidInput("Invalid base HTML revision.");
      return {
        ...identity,
        kind: "html",
        baseHtmlRevision: revision,
        html: string(value.html, true),
      };
    }
    case "comment.add":
      return {
        ...identity,
        kind: "comment.add",
        anchor: anchor(value.anchor),
        text: string(value.text),
      };
    case "comment.reply":
      return {
        ...identity,
        kind: "comment.reply",
        commentId: string(value.commentId),
        text: string(value.text),
      };
    case "comment.resolve":
      return {
        ...identity,
        kind: "comment.resolve",
        commentId: string(value.commentId),
        resolved: boolean(value.resolved),
      };
    default:
      throw new InvalidInput("Unknown command kind.");
  }
}
export function parsePresence(input: unknown): Presence {
  const value = object(input);
  const sequence = value.sequence === undefined ? undefined : number(value.sequence);
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
    throw new InvalidInput("Invalid presence sequence.");
  return {
    sessionId: string(value.sessionId),
    actor: actor(value.actor),
    elementId: elementId(value.elementId),
    x: number(value.x),
    y: number(value.y),
    updatedAt: Date.now(),
    ...(sequence === undefined ? {} : { sequence }),
  };
}
export function parseCursor(input: string | null, fallback: number): number {
  if (input === null) return fallback;
  if (!/^\d+$/.test(input)) throw new InvalidInput("Invalid revision cursor.");
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new InvalidInput("Invalid revision cursor.");
  return value;
}

export function validatePlanName(input: unknown): string {
  const name = string(input);
  if (!name.trim() || name.length > 200)
    throw new InvalidInput("Plan name must contain 1 to 200 characters.");
  return name;
}
