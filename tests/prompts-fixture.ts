import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScopeClient } from "@irudd-scope/protocol/client";
import {
  type PromptCommand,
  type PromptItemInput,
  type PromptReply,
} from "@irudd-scope/protocol/prompts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

export const promptToken = "synthetic-prompts-publishing-token";
export const promptPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
export const promptJpeg =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==";
export const promptWebp =
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=";
export function promptItem(
  field: PromptItemInput["field"] = "subject",
  fragment = "a red bird",
): PromptItemInput {
  return {
    type: "text-to-image",
    structureId: "text-to-image-seven",
    structureVersion: 1,
    field,
    name: `Example ${field}`,
    fragment,
    description: "Synthetic example",
    exampleScene: { title: "Example scene", prompt: "A red bird in a tree." },
  };
}
export function createPromptItem(
  field: PromptItemInput["field"] = "subject",
): Extract<PromptCommand, { action: "create-item" }> {
  return {
    action: "create-item",
    requestId: randomUUID(),
    expectedRevision: 0,
    id: randomUUID(),
    item: promptItem(field),
  };
}
export function promptReply<T extends PromptReply["type"]>(
  reply: PromptReply,
  type: T,
): Extract<PromptReply, { type: T }> {
  if (reply.type !== type) throw new Error(`Expected ${type}, received ${reply.type}`);
  return reply as Extract<PromptReply, { type: T }>;
}
export async function promptsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-prompts-"));
  let server = await startArtifactServer({ directory, token: promptToken, port: 0 });
  let client = new ScopeClient(server.url, promptToken);
  return {
    directory,
    get server() {
      return server;
    },
    get client() {
      return client;
    },
    restart: async () => {
      await server.close();
      server = await startArtifactServer({ directory, token: promptToken, port: 0 });
      client = new ScopeClient(server.url, promptToken);
    },
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
