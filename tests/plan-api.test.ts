import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import {
  readPlanSnapshot,
  PLAN_READ_CONFLICT,
  MAX_PLAN_REPLY_BYTES,
  PlanComment,
  PlanRound,
  PlanResponse,
  type PlanCommand,
} from "@irudd-scope/protocol/plan";

const token = "synthetic-plan-api-publishing-token";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-api-"));
  const server = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(server.url, token);
  return {
    directory,
    server,
    client,
    close: async () => {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function publish(client: ScopeClient, name = "api-plan") {
  return client.publish(
    randomUUID(),
    {
      name,
      title: "API plan",
      kind: "plan",
      mediaType: "text/html",
      fileName: "plan.html",
      expectedRevision: 0,
    },
    Buffer.from("<h1>Original</h1>"),
  );
}
async function request(url: string, command: unknown, authenticated = true) {
  return fetch(`${url}/v1/plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(command),
  });
}

test("the authenticated plan HTTP API supports headless review, marked screenshots, atomic response and events", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const events: { type: string; event?: string }[] = [];
  const watching = f.client
    .watch((event) => {
      events.push(event);
    }, controller.signal)
    .catch(() => {});
  try {
    const artifact = await publish(f.client);
    const initial = await f.client.plan({ action: "read", name: "api-plan" });
    if (initial.type !== "snapshot") throw new Error("Expected snapshot");
    expect(initial.snapshot.revisions).toHaveLength(1);
    expect(
      await f.client.plan({ action: "read", name: "api-plan", since: initial.snapshot.version }),
    ).toEqual({ type: "unchanged", version: initial.snapshot.version });
    const command: PlanCommand = {
      action: "comment",
      name: "api-plan",
      requestId: randomUUID(),
      revision: artifact.revision,
      text: "Show the boundary",
      page: "Architecture",
      image: png,
      annotatedImage: png,
      annotations: [{ type: "box", from: { x: 0.2, y: 0.2 }, to: { x: 0.8, y: 0.8 } }],
    };
    const added = await f.client.plan(command);
    if (added.type !== "receipt") throw new Error("Expected receipt");
    expect(added.recordId).toBe(command.requestId);
    const comment = (await readPlanSnapshot((command) => f.client.plan(command), "api-plan"))
      .comments[0];
    expect(Buffer.from(await f.client.planImage("api-plan", comment.image.id))).toEqual(
      Buffer.from(png, "base64"),
    );
    expect(Buffer.from(await f.client.planContent("api-plan", artifact.revision))).toEqual(
      Buffer.from("<h1>Original</h1>"),
    );
    const submitted = await f.client.plan({
      action: "submit",
      name: "api-plan",
      requestId: randomUUID(),
      commentIds: [comment.id],
    });
    if (submitted.type !== "receipt") throw new Error("Expected receipt");
    const response = await f.client.plan({
      action: "respond",
      name: "api-plan",
      requestId: randomUUID(),
      expectedRevision: artifact.revision,
      roundId: submitted.recordId!,
      summary: "Updated boundary",
      replies: [{ commentId: comment.id, text: "The boundary is labelled" }],
      html: "<h1>Updated</h1>",
    });
    if (response.type !== "receipt") throw new Error("Expected receipt");
    expect(response.artifact.revision).toBe(artifact.revision + 1);
    expect(Buffer.from(await f.client.planContent("api-plan", artifact.revision))).toEqual(
      Buffer.from("<h1>Original</h1>"),
    );
    expect(Buffer.from(await f.client.content(artifact.id))).toEqual(
      Buffer.from("<h1>Updated</h1>"),
    );
    await expect
      .poll(() => events.filter((event) => event.type === "plan").map((event) => event.event))
      .toEqual(["comment", "round", "response"]);
  } finally {
    controller.abort();
    await watching;
    await f.close();
  }
});

test("comment deletion rejects other plans and submitted feedback, including a concurrent submission", async () => {
  const f = await fixture();
  try {
    await publish(f.client);
    await publish(f.client, "other-plan");
    const comment = {
      action: "comment" as const,
      name: "api-plan",
      requestId: randomUUID(),
      revision: 1,
      text: "Queued comment",
      page: "overview",
      image: png,
      annotatedImage: png,
      annotations: [],
    };
    await f.client.plan(comment);
    const deletion = {
      action: "delete-comment" as const,
      name: "api-plan",
      requestId: randomUUID(),
      commentId: comment.requestId,
    };
    expect((await request(f.server.url, { ...deletion, name: "other-plan" })).status).toBe(409);
    expect((await request(f.server.url, { ...deletion, commentId: randomUUID() })).status).toBe(
      409,
    );
    expect((await request(f.server.url, { ...deletion, commentId: "invalid" })).status).toBe(400);
    await f.client.plan({
      action: "submit",
      name: "api-plan",
      requestId: randomUUID(),
      commentIds: [comment.requestId],
    });
    expect((await request(f.server.url, deletion)).status).toBe(409);
    const queuedId = randomUUID();
    await f.client.plan({ ...comment, requestId: queuedId });
    const results = await Promise.all([
      request(f.server.url, { ...deletion, requestId: randomUUID(), commentId: queuedId }),
      request(f.server.url, {
        action: "submit",
        name: "api-plan",
        requestId: randomUUID(),
        commentIds: [queuedId],
      }),
    ]);
    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const saved = await readPlanSnapshot((command) => f.client.plan(command), "api-plan");
    expect(saved.comments.some((entry) => entry.id === comment.requestId)).toBe(true);
    for (const round of saved.rounds)
      expect(round.commentIds.every((id) => saved.comments.some((entry) => entry.id === id))).toBe(
        true,
      );
    await f.client.plan({
      action: "respond",
      name: "api-plan",
      requestId: randomUUID(),
      roundId: saved.rounds[0].id,
      expectedRevision: 1,
      summary: "Answered",
      replies: [{ commentId: comment.requestId, text: "Reply" }],
    });
    expect((await request(f.server.url, deletion)).status).toBe(409);
  } finally {
    await f.close();
  }
});

test("plan endpoints reject unauthenticated, browser-origin, invalid image and conflicting publication requests", async () => {
  const f = await fixture();
  try {
    const artifact = await publish(f.client);
    expect((await request(f.server.url, { action: "read", name: "api-plan" }, false)).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${f.server.url}/v1/plans`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" },
          body: JSON.stringify({ action: "read", name: "api-plan" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(f.server.url, { action: "read", name: "api-plan", unexpected: "field" }))
        .status,
    ).toBe(400);
    const command = {
      action: "comment",
      name: "api-plan",
      requestId: randomUUID(),
      revision: artifact.revision,
      text: "Comment",
      page: "overview",
      image: Buffer.from("not PNG").toString("base64"),
      annotatedImage: png,
      annotations: [],
    };
    expect((await request(f.server.url, command)).status).toBe(400);
    expect((await request(f.server.url, { ...command, image: png.slice(0, -8) })).status).toBe(400);
    expect(
      (await request(f.server.url, { ...command, image: png, revision: artifact.revision + 20 }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(f.server.url, {
          ...command,
          image: png,
          annotatedImage: Buffer.from("invalid PNG").toString("base64"),
        })
      ).status,
    ).toBe(400);
    const beforeValid = await f.client.plan({ action: "read", name: "api-plan" });
    if (beforeValid.type !== "snapshot") throw new Error("Expected snapshot");
    expect(beforeValid.snapshot.comments).toHaveLength(0);
    const valid = { ...command, image: png };
    expect((await request(f.server.url, valid)).status).toBe(200);
    expect(
      (await request(f.server.url, Object.fromEntries(Object.entries(valid).reverse()))).status,
    ).toBe(200);
    expect((await request(f.server.url, { ...valid, text: "Different" })).status).toBe(409);
    const updated = {
      title: "Wrong kind",
      mediaType: "text/html",
      fileName: "plan.html",
      kind: "html" as const,
      expectedRevision: artifact.revision,
    };
    await expect(
      f.client.publish(artifact.id, updated, Buffer.from("<p>Changed</p>")),
    ).rejects.toThrow("kind cannot change");
    await expect(
      f.client.publish(
        randomUUID(),
        {
          title: "Unnamed",
          kind: "plan",
          mediaType: "text/html",
          fileName: "plan.html",
          expectedRevision: 0,
        },
        Buffer.from("<p>Unnamed</p>"),
      ),
    ).rejects.toThrow();
    expect(
      (
        await fetch(`${f.server.url}/v1/plans/api-plan/images/${"a".repeat(64)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

test("schema 5 migration preserves ordinary artifact content, named metadata and retention values", async () => {
  const f = await fixture();
  const artifact = await f.client.publish(
    "legacy-tab",
    {
      name: "legacy-name",
      title: "Legacy",
      kind: "text",
      mediaType: "text/plain",
      fileName: "legacy.txt",
      expectedRevision: 0,
    },
    Buffer.from("Original bytes"),
  );
  const filename = f.server.store.filename;
  await f.server.close();
  const db = new DatabaseSync(filename);
  try {
    db.exec(
      "DROP TABLE plan_drafts; DROP TABLE plan_receipts; DROP TABLE plan_records; DROP TABLE plan_images; DROP TABLE plan_revisions; DROP TABLE plan_state; DROP TABLE pull_requests_receipts; DROP TABLE pull_requests_current; DROP TABLE pull_requests_state; PRAGMA user_version = 5;",
    );
    db.prepare(
      "UPDATE live_tabs SET permanent = 1, last_visible_at = 123, trashed_at = 456 WHERE artifact_id = ?",
    ).run(artifact.id);
  } finally {
    db.close();
  }
  const reopened = await startArtifactServer({ directory: f.directory, token, port: 0 });
  try {
    const client = new ScopeClient(reopened.url, token);
    expect(await client.get(artifact.id)).toEqual(artifact);
    expect(Buffer.from(await client.content(artifact.id))).toEqual(Buffer.from("Original bytes"));
    expect((await reopened.store.tabs())[0]).toMatchObject({
      permanent: 1,
      last_visible_at: 123,
      trashed_at: 456,
    });
    const migrated = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
    } finally {
      migrated.close();
    }
  } finally {
    await reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("plan history above 16 MiB stays writable and pages revisions, selected rounds and pending work without stale cursors", async () => {
  const f = await fixture();
  try {
    const original = await publish(f.client);
    const text = "评".repeat(16_384);
    const firstRequest: Extract<PlanCommand, { action: "comment" }> = {
      action: "comment",
      name: "api-plan",
      requestId: randomUUID(),
      revision: original.revision,
      text,
      page: "页面",
      image: png,
      annotatedImage: png,
      annotations: [],
    };
    const firstReceipt = await f.client.plan(firstRequest);
    expect(firstReceipt.type).toBe("receipt");
    const first = (await readPlanSnapshot((command) => f.client.plan(command), "api-plan"))
      .comments[0];
    const db = new DatabaseSync(f.server.store.filename);
    const tabId = (await f.server.store.tabs())[0].id;
    const ids = [first.id];
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO plan_records(tab_id, kind, id, document) VALUES (?, 'comment', ?, ?)",
      );
      for (let index = 1; index < 339; index++) {
        const comment = {
          ...first,
          id: randomUUID(),
          page: "页".repeat(512),
          selectedText: "选".repeat(512),
        };
        ids.push(comment.id);
        insert.run(tabId, comment.id, JSON.stringify(PlanComment.make(comment)));
      }
      const revision = db.prepare(
        "INSERT INTO plan_revisions(tab_id, revision, blob_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (let value = 2; value <= 241; value++)
        revision.run(tabId, value, original.blob, `Revision ${value}`, original.updatedAt);
      const head = { ...original, revision: 241 };
      db.prepare("UPDATE artifacts SET revision = ?, document = ? WHERE id = ?").run(
        head.revision,
        JSON.stringify(head),
        head.id,
      );
      db.prepare("UPDATE plan_state SET version = version + 578 WHERE tab_id = ?").run(tabId);
      db.prepare("UPDATE lifecycle SET value = 241 WHERE name = 'max_revision'").run();
      db.exec("COMMIT");
      expect(
        Number(
          db
            .prepare(
              "SELECT sum(length(CAST(document AS BLOB))) AS bytes FROM plan_records WHERE tab_id = ?",
            )
            .get(tabId)?.bytes,
        ),
      ).toBeGreaterThan(MAX_PLAN_REPLY_BYTES);
    } finally {
      db.close();
    }
    const nextComment = {
      ...firstRequest,
      requestId: randomUUID(),
      revision: 241,
      text: "The next comment still writes",
    };
    const receipt = await f.client.plan(nextComment);
    expect(receipt).toMatchObject({ type: "receipt", recordId: nextComment.requestId });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(16 * 1024);
    expect(await f.client.plan(nextComment)).toEqual(receipt);
    let cursor: Extract<PlanCommand, { action: "read" }>["cursor"];
    const revisions: number[] = [];
    const comments: string[] = [];
    let pages = 0;
    do {
      const response = await request(f.server.url, {
        action: "read",
        name: "api-plan",
        ...(cursor ? { cursor } : {}),
      });
      expect(response.status).toBe(200);
      const bytes = await response.arrayBuffer();
      expect(bytes.byteLength).toBeLessThan(MAX_PLAN_REPLY_BYTES);
      const page = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(page.snapshot.revisions.length).toBeLessThanOrEqual(100);
      expect(
        page.snapshot.comments.length +
          page.snapshot.rounds.length +
          page.snapshot.responses.length,
      ).toBeLessThanOrEqual(100);
      revisions.push(
        ...page.snapshot.revisions.map((entry: { revision: number }) => entry.revision),
      );
      comments.push(...page.snapshot.comments.map((entry: { id: string }) => entry.id));
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(3);
    expect(revisions).toEqual(Array.from({ length: 241 }, (_, index) => index + 1));
    expect(comments).toEqual([...ids, nextComment.requestId]);
    const submitted = await f.client.plan({
      action: "submit",
      name: "api-plan",
      requestId: randomUUID(),
      commentIds: ids.slice(0, 2),
    });
    if (submitted.type !== "receipt") throw new Error("Expected receipt");
    const pending = await readPlanSnapshot((command) => f.client.plan(command), "api-plan", {
      pending: true,
    });
    expect(pending.comments).toHaveLength(0);
    expect(pending.responses).toHaveLength(0);
    expect(pending.rounds.map((round) => round.id)).toEqual([submitted.recordId]);
    expect(pending.revisions.map((entry) => entry.revision)).toEqual([241]);
    const selected = await readPlanSnapshot((command) => f.client.plan(command), "api-plan", {
      roundId: submitted.recordId,
    });
    expect(selected.comments.map((comment) => comment.id)).toEqual(ids.slice(0, 2));
    expect(selected.revisions.map((entry) => entry.revision)).toEqual([1, 241]);
    const responded = await f.client.plan({
      action: "respond",
      name: "api-plan",
      requestId: randomUUID(),
      roundId: submitted.recordId!,
      expectedRevision: 241,
      summary: "Handled selected round",
      replies: ids.slice(0, 2).map((commentId) => ({ commentId, text: "Addressed" })),
      html: "<h1>Latest</h1>",
    });
    expect(responded).toMatchObject({ type: "receipt", artifact: { revision: 242 } });
    const answered = await readPlanSnapshot((command) => f.client.plan(command), "api-plan", {
      roundId: submitted.recordId,
    });
    expect(answered.responses).toHaveLength(1);
    expect(answered.rounds[0].status).toBe("responded");
    expect(answered.revisions.map((entry) => entry.revision)).toEqual([1, 242]);
    expect(
      (await readPlanSnapshot((command) => f.client.plan(command), "api-plan", { pending: true }))
        .rounds,
    ).toHaveLength(0);
    const beforeWrite = await f.client.plan({ action: "read", name: "api-plan" });
    if (beforeWrite.type !== "snapshot" || !beforeWrite.next)
      throw new Error("Expected page cursor");
    await f.client.plan({
      action: "approve",
      name: "api-plan",
      requestId: randomUUID(),
      expectedRevision: 242,
    });
    await expect(
      f.client.plan({ action: "read", name: "api-plan", cursor: beforeWrite.next }),
    ).rejects.toThrow(PLAN_READ_CONFLICT);
    await expect(
      f.client.plan({
        action: "read",
        name: "api-plan",
        pending: true,
        roundId: submitted.recordId,
      }),
    ).rejects.toThrow("either pending");
    const restored = await readPlanSnapshot((command) => f.client.plan(command), "api-plan");
    expect(restored.comments).toHaveLength(340);
    expect(restored.revisions).toHaveLength(242);
  } finally {
    await f.close();
  }
});

test("selected-round pages count serialized UTF-8 bytes before loading large escaped records", async () => {
  const f = await fixture();
  try {
    const artifact = await publish(f.client);
    const text = "\u0000".repeat(16_384);
    await f.client.plan({
      action: "comment",
      name: "api-plan",
      requestId: randomUUID(),
      revision: artifact.revision,
      text,
      page: "",
      image: png,
      annotatedImage: png,
      annotations: [],
    });
    const first = (await readPlanSnapshot((command) => f.client.plan(command), "api-plan"))
      .comments[0];
    const comments = [
      first,
      ...Array.from({ length: 99 }, () => PlanComment.make({ ...first, id: randomUUID() })),
    ];
    const round = PlanRound.make({
      id: randomUUID(),
      revision: artifact.revision,
      commentIds: comments.map((comment) => comment.id),
      createdAt: first.createdAt,
      status: "responded",
    });
    const response = PlanResponse.make({
      id: randomUUID(),
      roundId: round.id,
      baseRevision: artifact.revision,
      revision: artifact.revision,
      summary: text,
      replies: comments.map((comment) => ({ commentId: comment.id, text })),
      createdAt: first.createdAt,
      seen: false,
    });
    const tabId = (await f.server.store.tabs())[0].id;
    const db = new DatabaseSync(f.server.store.filename);
    try {
      db.exec("BEGIN");
      const insert = db.prepare(
        "INSERT INTO plan_records(tab_id, kind, id, document) VALUES (?, ?, ?, ?)",
      );
      insert.run(tabId, "round", round.id, JSON.stringify(round));
      insert.run(tabId, "response", response.id, JSON.stringify(response));
      for (const comment of comments.slice(1))
        insert.run(tabId, "comment", comment.id, JSON.stringify(comment));
      db.prepare("UPDATE plan_state SET version = version + 101 WHERE tab_id = ?").run(tabId);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const firstPage = await f.client.plan({ action: "read", name: "api-plan", roundId: round.id });
    if (firstPage.type !== "snapshot" || !firstPage.next) throw new Error("Expected bounded page");
    expect(firstPage.snapshot.responses).toHaveLength(1);
    expect(
      firstPage.snapshot.comments.length +
        firstPage.snapshot.rounds.length +
        firstPage.snapshot.responses.length,
    ).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(firstPage))).toBeLessThan(MAX_PLAN_REPLY_BYTES);
    const full = await readPlanSnapshot((command) => f.client.plan(command), "api-plan", {
      roundId: round.id,
    });
    expect(full.comments).toHaveLength(100);
    expect(full.responses[0].replies).toHaveLength(100);
    expect(full.revisions).toHaveLength(1);
    const receipt = await f.client.plan({
      action: "seen",
      name: "api-plan",
      requestId: randomUUID(),
      responseId: response.id,
      seen: true,
    });
    expect(receipt.type).toBe("receipt");
    await expect(
      f.client.plan({
        action: "read",
        name: "api-plan",
        roundId: round.id,
        cursor: firstPage.next,
      }),
    ).rejects.toThrow(PLAN_READ_CONFLICT);
    const current = await readPlanSnapshot((command) => f.client.plan(command), "api-plan", {
      roundId: round.id,
    });
    expect(current.responses[0].seen).toBe(true);
    expect(current.comments).toHaveLength(100);
  } finally {
    await f.close();
  }
});
