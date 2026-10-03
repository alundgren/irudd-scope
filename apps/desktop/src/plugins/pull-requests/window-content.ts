import { Schema } from "effect";
import { decode, MAX_CONTENT_BYTES } from "@irudd-scope/protocol";
import type { FrameIdentity, WindowContext } from "./frame-sdk.ts";

const Content = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  html: Schema.String.check(Schema.isMinLength(1)),
  context: Schema.optional(Schema.Unknown),
});
export type ContentWindow = {
  identity: FrameIdentity;
  environment: WindowContext;
  title: string;
  html: string;
  z: number;
};

export function windowJSON(value: unknown): unknown {
  function validate(item: unknown, depth: number): void {
    if (depth > 32) throw new Error("Window context is nested too deeply.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" ||
      !item ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
    )
      throw new Error("Window context and messages must contain JSON values.");
    for (const entry of Object.values(item)) validate(entry, depth + 1);
  }
  validate(value, 0);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 64 * 1024)
    throw new Error("Window context and messages must fit within 64 KiB.");
  return JSON.parse(json);
}

export function windowContent(value: unknown) {
  const content = decode(Content, value);
  if (new TextEncoder().encode(content.html).byteLength > MAX_CONTENT_BYTES)
    throw new Error("Window HTML exceeds the content limit.");
  return { title: content.title, html: content.html, context: windowJSON(content.context ?? null) };
}
