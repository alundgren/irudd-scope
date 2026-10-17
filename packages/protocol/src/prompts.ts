import { Schema } from "effect";
import { BlobId, PublicationTabId, Revision, decode } from "./index.ts";

export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_PROMPT_REPLY_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_EXPORT_BYTES = 128 * 1024 * 1024;
export const MAX_PROMPT_ITEMS = 2000;
export const PROMPT_PAGE_SIZE = 25;
export const PROMPT_FIELDS = [
  "subject",
  "action",
  "environment",
  "lighting",
  "style",
  "composition",
  "camera",
] as const;
export const PromptField = Schema.Literals(PROMPT_FIELDS);
export type PromptField = typeof PromptField.Type;
export const PromptItemId = PublicationTabId;
const Text = Schema.String.check(Schema.isMaxLength(8192));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const Description = Schema.String.check(Schema.isMaxLength(2048));
export const PromptPart = Schema.Struct({ itemId: Schema.NullOr(PromptItemId), text: Text });
export type PromptPart = typeof PromptPart.Type;
export const PromptParts = Schema.Struct({
  subject: PromptPart,
  action: PromptPart,
  environment: PromptPart,
  lighting: PromptPart,
  style: PromptPart,
  composition: PromptPart,
  camera: PromptPart,
});
export type PromptParts = typeof PromptParts.Type;
const StructureIdentity = {
  type: Schema.Literal("text-to-image"),
  structureId: Schema.Literal("text-to-image-seven"),
  structureVersion: Schema.Literal(1),
};
export const PromptDocument = Schema.Struct({ ...StructureIdentity, parts: PromptParts });
export type PromptDocument = typeof PromptDocument.Type;
export const PromptWorkspace = Schema.Struct({ revision: Revision, document: PromptDocument });
export type PromptWorkspace = typeof PromptWorkspace.Type;
export const PromptStructure = Schema.Struct({
  ...StructureIdentity,
  name: Name,
  assemblyId: Schema.Literal("sentences-v1"),
  fields: Schema.Array(Schema.Struct({ id: PromptField, name: Name, guidance: Description })).check(
    Schema.isMaxLength(7),
  ),
});
export type PromptStructure = typeof PromptStructure.Type;
export const PROMPT_STRUCTURE: PromptStructure = {
  type: "text-to-image",
  structureId: "text-to-image-seven",
  structureVersion: 1,
  name: "Text to image",
  assemblyId: "sentences-v1",
  fields: [
    {
      id: "subject",
      name: "Subject",
      guidance: "Describe the main person, creature or object and its distinguishing details.",
    },
    {
      id: "action",
      name: "Action",
      guidance: "Describe what the subject is doing, including pose and movement.",
    },
    {
      id: "environment",
      name: "Environment",
      guidance: "Describe the location, surroundings, weather and time.",
    },
    {
      id: "lighting",
      name: "Lighting",
      guidance: "Describe the light sources, direction, softness and color.",
    },
    { id: "style", name: "Style", guidance: "Describe the medium, visual treatment and texture." },
    {
      id: "composition",
      name: "Composition",
      guidance: "Describe framing, placement, depth and balance.",
    },
    {
      id: "camera",
      name: "Camera",
      guidance: "Describe viewpoint, lens, focus and camera settings.",
    },
  ],
};
export function emptyPromptDocument(): PromptDocument {
  return decode(PromptDocument, {
    type: PROMPT_STRUCTURE.type,
    structureId: PROMPT_STRUCTURE.structureId,
    structureVersion: PROMPT_STRUCTURE.structureVersion,
    parts: Object.fromEntries(PROMPT_FIELDS.map((field) => [field, { itemId: null, text: "" }])),
  });
}
export function assemblePrompt(document: PromptDocument): string {
  return PROMPT_FIELDS.flatMap((field) => {
    const text = document.parts[field].text
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.,;:\s]+$/, "");
    return text ? [`${text.charAt(0).toUpperCase()}${text.slice(1)}.`] : [];
  }).join(" ");
}
export const PromptImage = Schema.Struct({
  id: BlobId,
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PROMPT_IMAGE_BYTES })),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 })),
});
export type PromptImage = typeof PromptImage.Type;
export const PromptExampleScene = Schema.Struct({
  title: Name,
  prompt: Text.check(Schema.isMinLength(1)),
});
const ItemFields = {
  ...StructureIdentity,
  field: PromptField,
  name: Name,
  fragment: Text.check(Schema.isMinLength(1)),
  description: Schema.optionalKey(Description),
  exampleScene: Schema.optionalKey(PromptExampleScene),
};
export const PromptItemInput = Schema.Struct(ItemFields);
export type PromptItemInput = typeof PromptItemInput.Type;
export const PromptItem = Schema.Struct({
  ...ItemFields,
  id: PromptItemId,
  revision: Revision.check(Schema.isGreaterThan(0)),
  image: Schema.optionalKey(PromptImage),
});
export type PromptItem = typeof PromptItem.Type;
export const PromptImageInput = Schema.Struct({
  mediaType: Schema.Literals(["image/png", "image/jpeg", "image/webp"]),
  base64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4),
  ),
});
const Mutation = { requestId: PublicationTabId, expectedRevision: Revision };
export const PromptCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("structures") }),
  Schema.Struct({ action: Schema.Literal("read-workspace") }),
  Schema.Struct({
    action: Schema.Literal("list-items"),
    field: Schema.optionalKey(PromptField),
    search: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
    cursor: Schema.optionalKey(Schema.Struct({ revision: Revision, after: PromptItemId })),
  }),
  Schema.Struct({ action: Schema.Literal("read-item"), id: PromptItemId }),
  Schema.Struct({
    action: Schema.Literal("update-workspace"),
    ...Mutation,
    document: PromptDocument,
  }),
  Schema.Struct({ action: Schema.Literal("reset-workspace"), ...Mutation }),
  Schema.Struct({
    action: Schema.Literal("create-item"),
    ...Mutation,
    id: PromptItemId,
    item: PromptItemInput,
  }),
  Schema.Struct({
    action: Schema.Literal("update-item"),
    ...Mutation,
    id: PromptItemId,
    item: PromptItemInput,
  }),
  Schema.Struct({ action: Schema.Literal("delete-item"), ...Mutation, id: PromptItemId }),
  Schema.Struct({
    action: Schema.Literal("set-image"),
    ...Mutation,
    id: PromptItemId,
    image: Schema.NullOr(PromptImageInput),
  }),
]);
export type PromptCommand = typeof PromptCommand.Type;
export const PromptReceipt = Schema.Struct({
  type: Schema.Literal("receipt"),
  requestId: PublicationTabId,
  action: Schema.Literals([
    "update-workspace",
    "reset-workspace",
    "create-item",
    "update-item",
    "delete-item",
    "set-image",
  ]),
  workspaceRevision: Revision,
  libraryRevision: Revision,
  itemId: Schema.optionalKey(PromptItemId),
  itemRevision: Schema.optionalKey(Revision),
});
export type PromptReceipt = typeof PromptReceipt.Type;
export const PromptReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("structures"),
    structures: Schema.Array(PromptStructure).check(Schema.isMaxLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("workspace"),
    workspace: PromptWorkspace,
    rendered: Schema.String.check(Schema.isMaxLength(7 * 8194)),
  }),
  Schema.Struct({
    type: Schema.Literal("items"),
    libraryRevision: Revision,
    items: Schema.Array(PromptItem).check(Schema.isMaxLength(PROMPT_PAGE_SIZE)),
    next: Schema.NullOr(Schema.Struct({ revision: Revision, after: PromptItemId })),
  }),
  Schema.Struct({ type: Schema.Literal("item"), libraryRevision: Revision, item: PromptItem }),
  PromptReceipt,
]);
export type PromptReply = typeof PromptReply.Type;
export { PromptEvent } from "./index.ts";
export const PromptExportManifest = Schema.Struct({
  format: Schema.Literal("scope-prompt-library"),
  version: Schema.Literal(1),
  libraryRevision: Revision,
  structures: Schema.Array(PromptStructure).check(Schema.isMaxLength(1)),
  itemsFile: Schema.Literal("library.json"),
  itemCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_PROMPT_ITEMS })),
  images: Schema.Array(
    Schema.Struct({
      ...PromptImage.fields,
      file: Schema.String.check(Schema.isPattern(/^images\/[a-f0-9]{64}\.(?:png|jpg|webp)$/)),
    }),
  ).check(Schema.isMaxLength(MAX_PROMPT_ITEMS)),
});
export type PromptExportManifest = typeof PromptExportManifest.Type;
export const PromptsGuide = {
  commands: [
    "prompts guide",
    "prompts structures",
    "prompts read",
    "prompts list",
    "prompts item UUID",
    "prompts apply REQUEST.json",
    "prompts image REQUEST.json IMAGE",
    "prompts export --output NEW_FILE.zip",
  ],
  workflow:
    "Library starts empty. Discover structures, list/read items, then curate through create-item/update-item/delete-item commands. Read workspace before update-workspace or reset-workspace. One current workspace is shared with the desktop. Selected item IDs must match the field; copied text may be edited. Library changes preserve copied workspace text. Delete detaches references and preserves text. Restore explicitly reads the latest item fragment.",
  concurrency:
    "Every mutation needs a stable UUID requestId and expectedRevision. New items use expectedRevision=0. Other item writes use the item revision; workspace writes use the workspace revision. An identical retry returns the original receipt. Never change its payload. On 409 read again and use a NEW requestId after reconsidering edits. List continuations carry library revision; restart pagination on 409. Use apply for field/search/cursor filters.",
  images:
    "PNG, JPEG and WebP, up to 8 MiB and 4096 pixels per dimension. File signature, container and dimension validation happen before storage. prompts image REQUEST.json IMAGE reads an explicit local file and replaces the image. The request file uses action=set-image with requestId, expectedRevision and item id, omitting image. set-image with image=null removes it. Optional exampleScene={title,prompt} is separately authored item metadata, never copied automatically from the current workspace.",
  export:
    "Export is a versioned library-only ZIP containing manifest.json, library.json, structure definitions and referenced images. It excludes the current workspace, credentials and other Scope content. Output must be a new path. No import or prompt generation is provided.",
  availability:
    "The desktop must be awake and connected, including through a paired hub. Prompt commands and exports are never queued offline and do not switch desktop tabs.",
  limits: {
    items: MAX_PROMPT_ITEMS,
    textCharacters: 8192,
    pageItems: PROMPT_PAGE_SIZE,
    requestBytes: MAX_PROMPT_REQUEST_BYTES,
    replyBytes: MAX_PROMPT_REPLY_BYTES,
    imageBytes: MAX_PROMPT_IMAGE_BYTES,
    exportBytes: MAX_PROMPT_EXPORT_BYTES,
  },
  schema: Schema.toJsonSchemaDocument(PromptCommand, { onExcessProperty: "error" }).schema,
};
