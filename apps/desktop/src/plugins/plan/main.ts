import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { ArtifactName, decode } from "@irudd-scope/protocol";
import type { MainPluginContext } from "../main-api.ts";

export function registerPlanIpc({ handle, client }: MainPluginContext) {
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
}
