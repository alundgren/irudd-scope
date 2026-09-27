import { expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactServer } from "../apps/desktop/src/artifacts/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";

const token = "synthetic-storage-migration-token";
async function legacyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-legacy-"));
  const bytes = Buffer.from("Legacy artifact content");
  const blob = createHash("sha256").update(bytes).digest("hex");
  const blobDirectory = join(directory, "blobs", blob.slice(0, 2));
  await mkdir(blobDirectory, { recursive: true });
  const file = join(blobDirectory, blob);
  await writeFile(file, bytes);
  const artifact = {
    id: "legacy-review",
    revision: 3,
    title: "Saved review",
    kind: "text",
    mediaType: "text/plain",
    fileName: "review.txt",
    blob,
    size: bytes.length,
    createdAt: "2026-09-20T08:00:00.000Z",
    updatedAt: "2026-09-21T08:00:00.000Z",
  };
  const db = new DatabaseSync(join(directory, "scope.db"));
  db.exec(
    "CREATE TABLE artifacts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL) STRICT; PRAGMA user_version = 1;",
  );
  db.prepare("INSERT INTO artifacts VALUES(?, ?, ?)").run(
    artifact.id,
    artifact.revision,
    JSON.stringify(artifact),
  );
  db.close();
  return { directory, bytes, file, artifact };
}

test("desktop storage migrates legacy content into SQLite, preserves revisions, and serves bytes after reopening without a blob directory", async () => {
  const { directory, bytes, artifact } = await legacyFixture();
  let server: Awaited<ReturnType<typeof startArtifactServer>> | undefined;
  try {
    server = await startArtifactServer({ directory, token, port: 0 });
    let client = new ScopeClient(server.url, token);
    expect(await client.get(artifact.id)).toEqual(artifact);
    expect(Buffer.from(await client.content(artifact.id))).toEqual(bytes);
    expect((await readdir(directory)).every((name) => /^scope\.db(?:-wal|-shm)?$/.test(name))).toBe(
      true,
    );
    await server.close();
    server = await startArtifactServer({ directory, token, port: 0 });
    client = new ScopeClient(server.url, token);
    expect(Buffer.from(await client.content(artifact.id))).toEqual(bytes);
    await client.publish(
      "same-content",
      {
        title: "Another view",
        kind: "text",
        fileName: "same.txt",
        mediaType: "text/plain",
        expectedRevision: 0,
      },
      bytes,
    );
    const db = new DatabaseSync(join(directory, "scope.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM blobs").get()?.count).toBe(1);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed legacy content check rolls back the migration and retains the original files and metadata", async () => {
  const { directory, bytes, file, artifact } = await legacyFixture();
  try {
    await writeFile(file, "Corrupt content");
    await expect(startArtifactServer({ directory, token, port: 0 })).rejects.toThrow(
      "failed verification",
    );
    expect(await readFile(file, "utf8")).toBe("Corrupt content");
    const db = new DatabaseSync(join(directory, "scope.db"));
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(
        JSON.parse(
          String(
            db.prepare("SELECT document FROM artifacts WHERE id = ?").get(artifact.id)?.document,
          ),
        ),
      ).toEqual(artifact);
    } finally {
      db.close();
    }
    await writeFile(file, bytes);
    const server = await startArtifactServer({ directory, token, port: 0 });
    try {
      expect(Buffer.from(await new ScopeClient(server.url, token).content(artifact.id))).toEqual(
        bytes,
      );
    } finally {
      await server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
