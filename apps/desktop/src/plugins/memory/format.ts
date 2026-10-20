import type { MemoryFields } from "./contract.ts";

export const memoryKind = (kind: string | undefined) =>
  ({ procedural: "Procedure", episodic: "Experience", semantic: "Fact" })[kind ?? ""] ??
  (kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Memory");
export const memoryStage = (stage: string | undefined) =>
  !stage || stage === "none" ? "No stage" : stage[0]!.toUpperCase() + stage.slice(1);
export function applicability(value: MemoryFields["applicability"]) {
  if (!value) return "No scope";
  if (value.type === "global") return "Everywhere";
  const kind = value.type === "repository" ? "Repository" : "Machine";
  return value.id ? `${kind} ${value.id}` : kind;
}
export const applicabilityType = (type: string) =>
  ({ global: "Everywhere", repository: "A repository", machine: "A machine" })[type] ?? type;
export function review(fields: MemoryFields) {
  if (fields.humanReviewed) return "Human reviewed";
  if (fields.trustTier) {
    const tier = fields.trustTier.replaceAll("-", " ");
    return tier[0]!.toUpperCase() + tier.slice(1);
  }
  return "Review unknown";
}
export function actor(value: { type: "agent" | "human"; id: string }) {
  if (value.type === "human")
    return value.id === "scope-user" ? "You in Scope" : `Person ${value.id}`;
  return `Agent ${value.id}`;
}
/** Local date and time with the zone, so recorded UTC times read correctly on every machine. */
export function time(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
export const action = (value: "create" | "update" | "delete") =>
  ({ create: "Created", update: "Updated", delete: "Removed" })[value];
export const outcome = (value: "pending" | "accepted" | "rejected" | "superseded") =>
  ({ pending: "Pending", accepted: "Accepted", rejected: "Rejected", superseded: "Replaced" })[
    value
  ];
