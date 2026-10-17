import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { ScopeError, decode } from "@irudd-scope/protocol";
import {
  MAX_PROMPT_IMAGE_BYTES,
  PromptImage,
  PromptImageInput,
} from "@irudd-scope/protocol/prompts";
import { validatePng } from "./image-validation.ts";

export function validatePromptImage(input: typeof PromptImageInput.Type): {
  image: PromptImage;
  bytes: Buffer;
} {
  const { base64, mediaType } = decode(PromptImageInput, input);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
    throw new ScopeError(400, "Example image must use canonical base64.");
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.toString("base64") !== base64)
    throw new ScopeError(400, "Example image must use canonical base64.");
  if (bytes.length > MAX_PROMPT_IMAGE_BYTES)
    throw new ScopeError(413, "Example image exceeds 8 MiB.");
  const signature = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : undefined;
  if (!signature || signature !== mediaType)
    throw new ScopeError(400, "Example image bytes do not match its media type.");
  if (signature === "image/png") validatePng(base64);
  if (
    signature === "image/jpeg" &&
    (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
  )
    throw new ScopeError(400, "JPEG image is incomplete.");
  if (signature === "image/webp") {
    if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length)
      throw new ScopeError(400, "WebP image length is invalid.");
    let offset = 12;
    let content = false;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      offset += 8 + size + (size % 2);
      if (offset > bytes.length) throw new ScopeError(400, "WebP image is incomplete.");
      if (["VP8 ", "VP8L", "ANMF"].includes(kind) && size > 0) content = true;
    }
    if (offset !== bytes.length || !content)
      throw new ScopeError(400, "WebP image has no complete image content.");
  }
  let dimensions;
  try {
    dimensions = imageSize(bytes);
  } catch {
    throw new ScopeError(400, "Example image header is invalid.");
  }
  const { width, height } = dimensions;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096
  )
    throw new ScopeError(400, "Example image dimensions must be between 1 and 4096 pixels.");
  return {
    bytes,
    image: decode(PromptImage, {
      id: createHash("sha256").update(bytes).digest("hex"),
      mediaType,
      size: bytes.length,
      width,
      height,
    }),
  };
}
export function promptImageFile(image: PromptImage): string {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[
    image.mediaType
  ];
  return `images/${image.id}.${extension}`;
}
