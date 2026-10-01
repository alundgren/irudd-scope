import { expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import type { Artifact } from "@irudd-scope/protocol";
import { readPlanSnapshot, type PlanCommand, type PlanSnapshot } from "@irudd-scope/protocol/plan";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const name = "storage-plan";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-plan-storage-"));
  const store = await ArtifactStore.open(directory);
  return {
    directory,
    store,
    close: async () => {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function publish(store: ArtifactStore, html: string, previous?: Artifact) {
  const id = previous?.id ?? "storage-plan-artifact";
  const tabId = await store.reserve(id, previous?.revision ?? 0);
  const blob = await store.upload(
    tabId,
    (async function* () {
      yield Buffer.from(html);
    })(),
  );
  return store.put(id, {
    tabId,
    blob,
    expectedRevision: previous?.revision ?? 0,
    name,
    title: "A plan",
    kind: "plan",
    mediaType: "text/html",
    fileName: "plan.html",
  });
}
async function snapshot(store: ArtifactStore): Promise<PlanSnapshot> {
  return readPlanSnapshot((command) => store.plans.command(command), name);
}
function comment(revision: number): Extract<PlanCommand, { action: "comment" }> {
  return {
    action: "comment",
    name,
    requestId: randomUUID(),
    revision,
    page: "overview",
    text: "Clarify the API",
    image: png,
    annotatedImage: png,
    annotations: [{ type: "pin", at: { x: 0.25, y: 0.75 } }],
  };
}

test("plan history survives publication, reclamation, restart and restore while preserving permanence", async () => {
  const f = await fixture();
  let reopened: ArtifactStore | undefined;
  try {
    const first = await publish(f.store, "<h1>First</h1>");
    const tab = (await f.store.tabs())[0];
    expect(tab.permanent).toBe(1);
    await f.store.setTabPermanent(tab.id, false);
    const second = await publish(f.store, "<h1>Second</h1>", first);
    await f.store.plans.command({
      action: "approve",
      name,
      requestId: randomUUID(),
      expectedRevision: second.revision,
    });
    await f.store.reclaim(Date.now() + 60 * 60_000);
    expect((await f.store.tabs())[0].permanent).toBe(0);
    expect(await f.store.plans.content(name, first.revision)).toEqual(
      Buffer.from("<h1>First</h1>"),
    );
    await f.store.close();
    reopened = await ArtifactStore.open(f.directory);
    expect((await snapshot(reopened)).revisions[1].approvedAt).toBeTruthy();
    const restored = await reopened.plans.command({
      action: "restore",
      name,
      requestId: randomUUID(),
      revision: first.revision,
      expectedRevision: second.revision,
    });
    expect(restored.type).toBe("receipt");
    const current = await snapshot(reopened);
    expect(current.artifact.revision).toBe(second.revision + 1);
    expect(await reopened.plans.content(name, current.artifact.revision)).toEqual(
      Buffer.from("<h1>First</h1>"),
    );
    expect(current.revisions.map((entry) => entry.revision)).toEqual([
      first.revision,
      second.revision,
      second.revision + 1,
    ]);
  } finally {
    await reopened?.close();
    if (!reopened) await f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("plan comments reuse screenshot bytes, retries preserve IDs, and rounds require complete atomic responses", async () => {
  const f = await fixture();
  try {
    const first = await publish(f.store, "<p>First</p>");
    const request = comment(first.revision);
    await Promise.all([f.store.plans.command(request), f.store.plans.command(request)]);
    let state = await snapshot(f.store);
    expect(state.comments).toHaveLength(1);
    const firstId = state.comments[0].id;
    await expect(
      f.store.plans.command({ ...request, action: "comment", text: "Changed" }),
    ).rejects.toThrow("different content");
    await f.store.plans.command(comment(first.revision));
    state = await snapshot(f.store);
    expect(state.comments[0].id).toBe(firstId);
    expect(state.comments[0].image.id).toBe(state.comments[1].image.id);
    await f.store.plans.command({
      action: "submit",
      name,
      requestId: randomUUID(),
      commentIds: state.comments.map((entry) => entry.id),
    });
    state = await snapshot(f.store);
    const round = state.rounds[0];
    const response = {
      action: "respond" as const,
      name,
      requestId: randomUUID(),
      roundId: round.id,
      expectedRevision: first.revision,
      summary: "Addressed review",
      replies: [{ commentId: firstId, text: "Added details" }],
      html: "<p>Second</p>",
    };
    await expect(f.store.plans.command(response)).rejects.toThrow("every comment");
    expect((await f.store.get(first.id)).revision).toBe(first.revision);
    const complete = {
      ...response,
      replies: state.comments.map((entry) => ({ commentId: entry.id, text: "Addressed" })),
    };
    await f.store.plans.command(complete);
    await f.store.plans.command(complete);
    state = await snapshot(f.store);
    expect(state.rounds[0].status).toBe("responded");
    expect(state.responses).toHaveLength(1);
    expect(state.artifact.revision).toBe(first.revision + 1);
    expect(state.comments.every((entry) => !entry.resolved)).toBe(true);
    expect(state.responses[0].seen).toBe(false);
    await f.store.plans.command({
      action: "resolve",
      name,
      requestId: randomUUID(),
      commentId: firstId,
      resolved: true,
    });
    expect((await snapshot(f.store)).responses[0].seen).toBe(false);
    await f.store.plans.command({
      action: "seen",
      name,
      requestId: randomUUID(),
      responseId: state.responses[0].id,
      seen: true,
    });
    await f.store.reclaim(Date.now() + 60 * 60_000);
    expect(await f.store.reclaim(Date.now() + 60 * 60_000)).toBe(0);
    expect(await f.store.plans.image(name, state.comments[0].image.id)).toEqual(
      Buffer.from(png, "base64"),
    );
    const db = new DatabaseSync(f.store.filename, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM plan_images").get()?.count).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("a reply without HTML may use a retained older revision and screenshots cannot belong to another plan", async () => {
  const f = await fixture();
  try {
    const first = await publish(f.store, "<p>First</p>");
    await f.store.plans.command(comment(first.revision));
    let state = await snapshot(f.store);
    await f.store.plans.command({
      action: "submit",
      name,
      requestId: randomUUID(),
      commentIds: [state.comments[0].id],
    });
    const second = await publish(f.store, "<p>Second</p>", first);
    state = await snapshot(f.store);
    await f.store.plans.command({
      action: "respond",
      name,
      requestId: randomUUID(),
      roundId: state.rounds[0].id,
      expectedRevision: first.revision,
      summary: "Explanation",
      replies: [
        { commentId: state.comments[0].id, text: "The current content already answers this" },
      ],
    });
    expect((await snapshot(f.store)).artifact.revision).toBe(second.revision);
    const tabId = await f.store.reserve("another-plan", 0);
    const blob = await f.store.upload(
      tabId,
      (async function* () {
        yield Buffer.from("<p>Other</p>");
      })(),
    );
    await f.store.put("another-plan", {
      tabId,
      blob,
      expectedRevision: 0,
      name: "other-plan",
      title: "Other",
      kind: "plan",
      mediaType: "text/html",
      fileName: "other.html",
    });
    await expect(f.store.plans.image("other-plan", state.comments[0].image.id)).rejects.toThrow(
      "not found",
    );
  } finally {
    await f.close();
  }
});

test("Trashcan retains plan history, screenshots, drafts and identities, then permanent deletion removes all bytes", async () => {
  const f = await fixture();
  try {
    const artifact = await publish(f.store, "<p>Plan</p>");
    const tab = (await f.store.tabs())[0];
    await f.store.openTab(
      {
        id: tab.id,
        groupId: randomUUID(),
        type: "plan",
        title: "Plan",
        state: { version: 1, data: { artifactId: artifact.id } },
      },
      artifact.revision,
    );
    await f.store.plans.command(comment(artifact.revision));
    const before = await snapshot(f.store);
    const draft = {
      revision: artifact.revision,
      image: png,
      width: 1,
      height: 1,
      text: "Unsent",
      page: "overview",
      annotations: [],
      requestId: randomUUID(),
    };
    await f.store.plans.saveDraft(tab.id, draft);
    await f.store.trashTab(tab.id, 123);
    await expect(f.store.plans.command(comment(artifact.revision))).rejects.toThrow("Trashcan");
    await f.store.reclaim(Date.now() + 60 * 60_000);
    expect(await snapshot(f.store)).toEqual(before);
    expect(await f.store.plans.draft(tab.id)).toEqual(draft);
    expect((await f.store.restoreTab(tab.id)).id).toBe(tab.id);
    expect((await snapshot(f.store)).comments[0].id).toBe(before.comments[0].id);
    await f.store.trashTab(tab.id, 456);
    await f.store.emptyTrash([{ id: tab.id, trashedAt: 456 }]);
    const db = new DatabaseSync(f.store.filename, { readOnly: true });
    try {
      for (const table of [
        "blobs",
        "plan_state",
        "plan_revisions",
        "plan_images",
        "plan_records",
        "plan_receipts",
        "plan_drafts",
      ])
        expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
