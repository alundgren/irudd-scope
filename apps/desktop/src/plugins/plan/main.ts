import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { ArtifactName, BlobId, Revision, decode } from "@irudd-scope/protocol";
import { PlanCommand, MAX_PLAN_IMAGE_BYTES } from "@irudd-scope/protocol/plan";
import { Uuid, tabArtifactId } from "../../workspace/contract.ts";
import { PlanDraft } from "./draft.ts";
import type { MainPluginContext } from "../main-api.ts";

const CapturePlan = Schema.Struct({
  tabId: Uuid,
  revision: Revision,
  rect: Schema.Struct({
    x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
    y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  }),
});

export function registerPlanIpc({
  handle,
  artifacts,
  client,
  workspace,
  window,
}: MainPluginContext) {
  handle("scope:create-plan", async (value) => {
    const input = decode(
      Schema.Struct({
        name: ArtifactName,
        title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
        html: Schema.String.check(Schema.isMaxLength(32 * 1024 * 1024)),
      }),
      value,
    );
    return client.publish(
      randomUUID(),
      {
        name: input.name,
        title: input.title,
        kind: "plan",
        mediaType: "text/html",
        fileName: `${input.name}.html`,
        expectedRevision: 0,
      },
      Buffer.from(input.html),
    );
  });
  handle("scope:plan-command", (value) => artifacts.plans.command(decode(PlanCommand, value)));
  handle("scope:plan-image", (value) => {
    const input = decode(Schema.Struct({ name: ArtifactName, id: BlobId }), value);
    return artifacts.plans.image(input.name, input.id);
  });
  handle("scope:plan-content", (value) => {
    const input = decode(Schema.Struct({ name: ArtifactName, revision: Revision }), value);
    return artifacts.plans.content(input.name, input.revision);
  });
  handle("scope:load-plan-draft", (value) => artifacts.plans.draft(decode(Uuid, value)));
  handle("scope:save-plan-draft", (value) => {
    const input = decode(Schema.Struct({ tabId: Uuid, draft: Schema.NullOr(PlanDraft) }), value);
    return artifacts.plans.saveDraft(input.tabId, input.draft);
  });
  handle("scope:capture-plan", async (value) => {
    const input = decode(CapturePlan, value);
    if (window.isDestroyed()) throw new Error("This Scope window is closed.");
    const zoom = window.webContents.getZoomFactor();
    const [contentWidth, contentHeight] = window.getContentSize();
    if (
      input.rect.x + input.rect.width > Math.ceil(contentWidth / zoom) ||
      input.rect.y + input.rect.height > Math.ceil(contentHeight / zoom)
    )
      throw new Error("The screenshot rectangle is outside the window.");
    const x = Math.floor(input.rect.x * zoom);
    const y = Math.floor(input.rect.y * zoom);
    const rect = {
      x,
      y,
      width: Math.min(contentWidth, Math.ceil((input.rect.x + input.rect.width) * zoom)) - x,
      height: Math.min(contentHeight, Math.ceil((input.rect.y + input.rect.height) * zoom)) - y,
    };
    if (rect.width <= 0 || rect.height <= 0)
      throw new Error("The screenshot rectangle is outside the window.");
    async function validateSelection() {
      if (window.isDestroyed() || !window.isVisible() || window.isMinimized())
        throw new Error("Show the plan in Scope before taking a screenshot.");
      const current = await workspace();
      const tab = current.tabs.find((entry) => entry.id === input.tabId);
      if (!tab || tab.type !== "plan" || current.selected !== input.tabId)
        throw new Error("Select this plan before taking a screenshot.");
      const id = tabArtifactId(tab);
      if (!id) throw new Error("The selected plan has no artifact.");
      const artifact = await artifacts.get(id);
      if (artifact.kind !== "plan" || !artifact.name)
        throw new Error("The selected tab is no longer a named plan.");
      await artifacts.plans.content(artifact.name, input.revision);
      const [width, height] = window.getContentSize();
      if (width !== contentWidth || height !== contentHeight)
        throw new Error("Window size changed while taking the screenshot. Try again.");
      if (rect.x + rect.width > width || rect.y + rect.height > height)
        throw new Error("The screenshot rectangle is outside the window.");
      return artifact;
    }
    const before = await validateSelection();
    const image = await window.webContents.capturePage(rect);
    const after = await validateSelection();
    if (window.webContents.getZoomFactor() !== zoom)
      throw new Error("Window zoom changed while taking the screenshot. Try again.");
    if (before.id !== after.id || before.revision !== after.revision)
      throw new Error("Plan changed while taking the screenshot.");
    const bytes = image.toPNG();
    if (image.isEmpty() || bytes.length < 24) throw new Error("The plan screenshot is empty.");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      bytes.byteLength > MAX_PLAN_IMAGE_BYTES
    )
      throw new Error("Screenshot exceeds the plan image limits.");
    return { image: bytes.toString("base64"), width, height };
  });
}
