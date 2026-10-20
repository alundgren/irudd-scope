import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";

const token = "synthetic-storage-migration-token";
test("simultaneous updates serialize their revision checks in SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-concurrent-"));
  const server = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(server.url, token);
  try {
    const metadata = {
      title: "Shared artifact",
      kind: "text" as const,
      mediaType: "text/plain",
      fileName: "review.txt",
    };
    await client.publish("shared", { ...metadata, expectedRevision: 0 }, Buffer.from("Original"));
    const results = await Promise.allSettled(
      ["First", "Second"].map((body) =>
        client.publish("shared", { ...metadata, expectedRevision: 1 }, Buffer.from(body)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.status).toBe(409);
    expect((await client.get("shared")).revision).toBe(2);
    expect(["First", "Second"]).toContain(Buffer.from(await client.content("shared")).toString());
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
