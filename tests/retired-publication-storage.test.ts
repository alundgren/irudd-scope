import { expect, test } from "vite-plus/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

test("schema 8 publication records survive edits and maintenance until their tab is deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scope-retired-publications-"));
  const token = "synthetic-retired-publication-token";
  const metadata = {
    title: "Saved HTML",
    kind: "html" as const,
    mediaType: "text/html",
    fileName: "saved.html",
  };
  const checkpoint = JSON.stringify({ operationId: randomUUID(), revision: 1 });
  const operation = JSON.stringify({ operationId: randomUUID(), state: "started" });
  const savedBytes = [Buffer.from("<h1>Published HTML</h1>"), Buffer.from("<h1>Pending HTML</h1>")];
  const blobs = savedBytes.map((bytes) => createHash("sha256").update(bytes).digest("hex"));
  let server: Awaited<ReturnType<typeof startArtifactServer>> | undefined;
  try {
    server = await startArtifactServer({ directory, token, port: 0 });
    let client = new ScopeClient(server.url, token);
    await client.publish(
      "saved-html",
      { ...metadata, expectedRevision: 0 },
      Buffer.from("<h1>Current</h1>"),
    );
    await server.close();
    server = undefined;
    const db = new DatabaseSync(join(directory, "scope.db"));
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
      const tabId = String(
        db.prepare("SELECT tab_id FROM artifacts WHERE id = ?").get("saved-html")?.tab_id,
      );
      db.exec("PRAGMA foreign_keys = ON");
      for (const [index, blob] of blobs.entries()) {
        db.prepare("INSERT INTO blobs(id, content) VALUES (?, ?)").run(blob, savedBytes[index]);
        db.prepare("INSERT INTO tab_blobs(tab_id, blob_id, staged_until) VALUES (?, ?, 0)").run(
          tabId,
          blob,
        );
      }
      db.prepare(
        "INSERT INTO publications(tab_id, provider, checkpoint, operation, checkpoint_blob, operation_blob) VALUES (?, 'sites', ?, ?, ?, ?)",
      ).run(tabId, checkpoint, operation, ...blobs);
    } finally {
      db.close();
    }

    server = await startArtifactServer({ directory, token, port: 0 });
    client = new ScopeClient(server.url, token);
    expect(Buffer.from(await client.content("saved-html")).toString()).toBe("<h1>Current</h1>");
    await client.publish(
      "saved-html",
      { ...metadata, expectedRevision: 1 },
      Buffer.from("<h1>Agent edit</h1>"),
    );
    await server.store.replaceContent(
      "saved-html",
      2,
      metadata.title,
      Buffer.from("<h1>Desktop edit</h1>"),
    );
    await server.store.reclaim(Date.now() + 60 * 60_000);
    await client.shrink();
    await server.close();
    server = undefined;

    server = await startArtifactServer({ directory, token, port: 0 });
    client = new ScopeClient(server.url, token);
    expect(Buffer.from(await client.content("saved-html")).toString()).toBe(
      "<h1>Desktop edit</h1>",
    );
    const retained = new DatabaseSync(join(directory, "scope.db"), { readOnly: true });
    try {
      expect(
        retained.prepare("SELECT checkpoint, operation FROM publications").get(),
      ).toMatchObject({ checkpoint, operation });
      for (const [index, blob] of blobs.entries()) {
        const row = retained.prepare("SELECT content FROM blobs WHERE id = ?").get(blob);
        expect(Buffer.from(row!.content as Uint8Array)).toEqual(savedBytes[index]);
      }
      expect(retained.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      retained.close();
    }
    const retiredRoute = await fetch(`${server.url}/v1/publications`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read", id: "saved-html" }),
    });
    expect(retiredRoute.status).toBe(404);
    await retiredRoute.arrayBuffer();
    expect(await client.delete("saved-html")).toMatchObject({ deleted: true });
    await server.store.reclaim(Date.now() + 60 * 60_000);
    await client.shrink();
    const emptied = new DatabaseSync(join(directory, "scope.db"), { readOnly: true });
    try {
      expect(emptied.prepare("SELECT count(*) AS count FROM publications").get()?.count).toBe(0);
      expect(emptied.prepare("SELECT count(*) AS count FROM blobs").get()?.count).toBe(0);
      expect(emptied.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      emptied.close();
    }
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
