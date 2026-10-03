import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Actor } from "../contracts.ts";
import { PlanStore } from "./store.ts";
import { parseCommand, validatePlanName } from "./validation.ts";
import { gitDiff } from "./html.ts";

const name = z.string().min(1).max(200);
const requestId = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Stable ID for this exact mutation. Retry the same payload and ID after an uncertain response; use a new ID for revised content.",
  );
const revision = z.number().int().min(1);
const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});
export function createPlanMcpServer(store: PlanStore, actor: Actor) {
  const server = new McpServer({ name: "plan-web", version: "0.1.0" });
  server.registerTool(
    "plan_read",
    { description: "Read the current HTML and discussions.", inputSchema: z.object({ name }) },
    ({ name }) => result(store.snapshot(validatePlanName(name))),
  );
  server.registerTool(
    "plan_version",
    {
      description: "Read an immutable document revision.",
      inputSchema: z.object({ name, revision }),
    },
    ({ name, revision }) => {
      const version = store.version(validatePlanName(name), revision);
      return version ? result(version) : result({ error: "Version not found." }, true);
    },
  );
  server.registerTool(
    "plan_history",
    {
      description: "Read paginated history and Git diffs.",
      inputSchema: z.object({
        name,
        before: revision.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    ({ name, before, limit }) => {
      const plan = validatePlanName(name);
      return result(store.versions(plan, before ?? store.snapshot(plan).revision + 1, limit));
    },
  );
  server.registerTool(
    "plan_diff",
    {
      description: "Compare HTML between two immutable document revisions.",
      inputSchema: z.object({ name, from: revision, to: revision }),
    },
    ({ name, from, to }) => {
      const plan = validatePlanName(name);
      const left = store.version(plan, from);
      const right = store.version(plan, to);
      return left && right
        ? result({ diff: gitDiff(left.html, right.html) })
        : result({ error: "Version not found." }, true);
    },
  );
  const mutate = (name: string, command: Record<string, unknown>) => {
    const outcome = store.command(validatePlanName(name), parseCommand({ ...command, actor }));
    return result(outcome.receipt, outcome.status !== 200);
  };
  server.registerTool(
    "plan_apply_html",
    {
      description:
        "Apply HTML using the current baseHtmlRevision. Read current content before writing. Preserve the requestId after uncertain replies.",
      inputSchema: z.object({ name, requestId, baseHtmlRevision: revision, html: z.string() }),
    },
    ({ name, ...command }) => mutate(name, { ...command, kind: "html" }),
  );
  server.registerTool(
    "plan_comment",
    {
      description: "Add a discussion anchored to authored HTML or a detached position.",
      inputSchema: z.object({
        name,
        requestId,
        text: z.string().min(1),
        anchor: z.object({
          elementId: z.string().nullable(),
          quote: z.string(),
          x: z.number().finite(),
          y: z.number().finite(),
        }),
      }),
    },
    ({ name, ...command }) => mutate(name, { ...command, kind: "comment.add" }),
  );
  server.registerTool(
    "plan_reply",
    {
      description: "Reply to a discussion.",
      inputSchema: z.object({
        name,
        requestId,
        commentId: z.string().min(1),
        text: z.string().min(1),
      }),
    },
    ({ name, ...command }) => mutate(name, { ...command, kind: "comment.reply" }),
  );
  server.registerTool(
    "plan_resolve",
    {
      description: "Resolve or reopen a discussion.",
      inputSchema: z.object({
        name,
        requestId,
        commentId: z.string().min(1),
        resolved: z.boolean(),
      }),
    },
    ({ name, ...command }) => mutate(name, { ...command, kind: "comment.resolve" }),
  );
  return server;
}
