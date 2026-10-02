import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import {
  type PublicationObservation,
  type PublicationSuccess,
  type PublicationProvider,
} from "@irudd-scope/protocol/publications";
const token = "synthetic-outbound-publication-test-token";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function observation(overrides: Partial<PublicationObservation> = {}): PublicationObservation {
  return {
    accountId: "test-account",
    workspaceId: null,
    remoteId: null,
    url: null,
    access: "owner",
    audience: "owner",
    evidence: "documented-private-default",
    checkedAt: new Date().toISOString(),
    marker: { version: null, updatedAt: null },
    conditionalWrite: true,
    ...overrides,
  };
}
function success(overrides: Partial<PublicationSuccess> = {}): PublicationSuccess {
  return {
    provider: "claude",
    remoteId: "remote-1",
    url: "https://claude.ai/code/artifact/remote-1",
    savedVersion: null,
    sourceCommit: null,
    deploymentId: null,
    marker: { version: "1", updatedAt: "2026-10-01T12:00:00.123456Z" },
    confirmedAt: new Date().toISOString(),
    state: "succeeded",
    ...overrides,
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-publications-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(() => server.close());
  let client = new ScopeClient(server.url, token);
  const publish = (
    content = "<h1>Original</h1>",
    expectedRevision = 0,
    kind: "html" | "text" = "html",
  ) =>
    client.publish(
      "presentation-id",
      {
        title: "Presentation",
        kind,
        mediaType: kind === "html" ? "text/html" : "text/plain",
        fileName: kind === "html" ? "presentation.html" : "presentation.txt",
        expectedRevision,
      },
      Buffer.from(content),
    );
  await publish();
  const { snapshot } = await client.publications({ action: "read", id: "presentation-id" });
  const operation = (provider: PublicationProvider = "claude") => ({
    id: snapshot.artifact.id,
    tabId: snapshot.tabId,
    provider,
    operationId: randomUUID(),
  });
  return {
    directory,
    publish,
    operation,
    async authorize(op: ReturnType<typeof operation>) {
      const read = await client.publications({ action: "read", id: op.id });
      const expectedObservation = read.snapshot.destinations.find(
        (item) => item.provider === op.provider,
      )?.operation?.observation;
      if (!expectedObservation) throw new Error("No operation to acknowledge.");
      return client.publications({ ...op, action: "authorize", expectedObservation });
    },
    get client() {
      return client;
    },
    async restart() {
      await server.close();
      server = await startArtifactServer({ directory, token, port: 0 });
      client = new ScopeClient(server.url, token);
    },
  };
}

test("outbound HTML pins bytes through updates, reclamation, restart and lost completion acknowledgement", async () => {
  const f = await fixture(),
    op = f.operation();
  const prepared = await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: observation(),
  });
  expect(prepared.decision).toBe("allowed");
  await f.client.publications({ ...op, action: "start" });
  await f.publish("<h1>New local revision</h1>", 1);
  await f.restart();
  const db = new DatabaseSync(join(f.directory, "scope.db"));
  db.prepare("UPDATE tab_blobs SET staged_until = 0").run();
  db.close();
  await f.client.shrink();
  expect(Buffer.from(await f.client.publicationContent(op.id, op.operationId)).toString()).toBe(
    "<h1>Original</h1>",
  );
  const result = success();
  const completed = await f.client.publications({ ...op, action: "complete", result });
  expect(completed.snapshot.artifact.revision).toBe(2);
  expect(completed.snapshot.destinations[0]?.checkpoint?.revision).toBe(1);
  expect(completed.snapshot.destinations[0]?.operation).toBeNull();
  await f.restart();
  expect(Buffer.from(await f.client.publicationContent(op.id, op.operationId)).toString()).toBe(
    "<h1>Original</h1>",
  );
  expect(await f.client.publications({ ...op, action: "complete", result })).toEqual(completed);
  await expect(
    f.client.publications({
      ...op,
      action: "complete",
      result: success({ marker: { version: "2", updatedAt: null } }),
    }),
  ).rejects.toThrow("different result");
  const recheck = f.operation();
  const unchanged = await f.client.publications({
    ...recheck,
    action: "prepare",
    expectedRevision: 2,
    observation: observation({
      remoteId: result.remoteId,
      url: result.url,
      evidence: "authenticated-share-inspection",
      marker: result.marker,
    }),
  });
  expect(unchanged.decision).toBe("allowed");
  await f.client.publications({ ...recheck, action: "cancel", acknowledgeUncertain: false });
  await f.client.delete(op.id);
  await expect(f.client.publications({ action: "read", id: op.id })).rejects.toThrow("not found");
});

test("newer remote dates and versions warn and cannot start without explicit authorization", async () => {
  const f = await fixture(),
    op = f.operation();
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: observation(),
  });
  await f.client.publications({ ...op, action: "start" });
  const result = success();
  await f.client.publications({ ...op, action: "complete", result });
  for (const marker of [
    { version: "2", updatedAt: null },
    { version: null, updatedAt: "2026-10-01T12:00:00.123457Z" },
    { version: null, updatedAt: null },
  ]) {
    const next = f.operation();
    const reply = await f.client.publications({
      ...next,
      action: "prepare",
      expectedRevision: 1,
      observation: observation({
        remoteId: result.remoteId,
        url: result.url,
        evidence: "authenticated-share-inspection",
        marker,
      }),
    });
    expect(reply.decision).toBe("warning");
    await expect(f.client.publications({ ...next, action: "start" })).rejects.toThrow("authorize");
    await f.authorize(next);
    await f.client.publications({ ...next, action: "start" });
    await expect(
      f.client.publications({ ...next, action: "cancel", acknowledgeUncertain: false }),
    ).rejects.toThrow("uncertain");
    await f.client.publications({ ...next, action: "cancel", acknowledgeUncertain: true });
  }
});

test("privacy, account evidence, artifact kinds and stale observations fail closed", async () => {
  const f = await fixture();
  for (const audience of ["public", "external", "unknown"] as const) {
    const op = f.operation();
    const reply = await f.client.publications({
      ...op,
      action: "prepare",
      expectedRevision: 1,
      observation: observation({ audience }),
    });
    expect(reply.decision).toBe("blocked");
    expect(reply.snapshot.destinations).toHaveLength(0);
  }
  const old = f.operation();
  expect(
    (
      await f.client.publications({
        ...old,
        action: "prepare",
        expectedRevision: 1,
        observation: observation({ checkedAt: "2025-01-01T00:00:00Z" }),
      })
    ).decision,
  ).toBe("blocked");
  const shared = f.operation("sites");
  expect(
    (
      await f.client.publications({
        ...shared,
        action: "prepare",
        expectedRevision: 1,
        observation: observation({ audience: "team", evidence: "authenticated-tool" }),
      })
    ).decision,
  ).toBe("blocked");
  const existing = f.operation();
  expect(
    (
      await f.client.publications({
        ...existing,
        action: "prepare",
        expectedRevision: 1,
        observation: observation({
          remoteId: "remote-1",
          url: "https://claude.ai/code/artifact/remote-1",
          evidence: "authenticated-tool",
        }),
      })
    ).decision,
  ).toBe("blocked");
  await f.publish("A text artifact", 1, "text");
  expect(
    (
      await f.client.publications({
        ...f.operation(),
        action: "prepare",
        expectedRevision: 2,
        observation: observation(),
      })
    ).decision,
  ).toBe("blocked");
  await f.publish("<h1>Scope API</h1><code>window.scope.pullRequests</code>", 2);
  expect(
    (
      await f.client.publications({
        ...f.operation(),
        action: "prepare",
        expectedRevision: 3,
        observation: observation(),
      })
    ).decision,
  ).toBe("allowed");
});

test("unresolved operations prevent duplicate creation and stale local starts", async () => {
  const f = await fixture(),
    op = f.operation();
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: observation(),
  });
  await expect(
    f.client.publications({
      ...f.operation(),
      action: "prepare",
      expectedRevision: 1,
      observation: observation(),
    }),
  ).rejects.toThrow("unresolved");
  await f.publish("<h1>Changed</h1>", 1);
  await expect(f.client.publications({ ...op, action: "start" })).rejects.toThrow(
    "local artifact changed",
  );
  await f.client.publications({ ...op, action: "cancel", acknowledgeUncertain: false });
  const next = f.operation();
  await f.client.publications({
    ...next,
    action: "prepare",
    expectedRevision: 2,
    observation: observation(),
  });
  await f.client.publications({ ...next, action: "start" });
  await f.restart();
  await expect(f.client.publications({ ...next, action: "start" })).rejects.toThrow("reconciled");
  await expect(
    f.client.publications({
      ...f.operation(),
      action: "prepare",
      expectedRevision: 2,
      observation: observation(),
    }),
  ).rejects.toThrow("unresolved");
  const progress = {
    remoteId: "created-remote",
    url: "https://claude.ai/code/artifact/created-remote",
    savedVersion: null,
    sourceCommit: null,
    deploymentId: null,
  };
  await expect(
    f.client.publications({
      ...next,
      action: "progress",
      progress: { ...progress, url: "https://example.com/remote" },
    }),
  ).rejects.toThrow("supported secure provider URL");
  await f.client.publications({ ...next, action: "progress", progress });
  await f.restart();
  expect(
    (await f.client.publications({ action: "read", id: next.id })).snapshot.destinations[0]
      ?.operation?.progress,
  ).toEqual(progress);
  await expect(
    f.client.publications({ ...next, action: "complete", result: success() }),
  ).rejects.toThrow("another destination");
  await expect(
    f.client.publications({
      action: "unlink",
      id: next.id,
      tabId: next.tabId,
      provider: next.provider,
      acknowledgeUncertain: false,
    }),
  ).rejects.toThrow("uncertain");
});

test("Sites accepts only the recorded source version and successful deployment result", async () => {
  const f = await fixture(),
    op = f.operation("sites");
  expect(
    (
      await f.client.publications({
        ...op,
        action: "prepare",
        expectedRevision: 1,
        observation: observation({ evidence: "authenticated-tool" }),
      })
    ).decision,
  ).toBe("allowed");
  await f.client.publications({ ...op, action: "start" });
  const progress = {
    remoteId: "site-1",
    url: "https://site-1.chatgpt.site",
    savedVersion: "1",
    sourceCommit: "a".repeat(40),
    deploymentId: null,
  };
  await f.client.publications({ ...op, action: "progress", progress });
  const result = success({
    ...progress,
    provider: "sites",
    deploymentId: "deploy-1",
    marker: { version: "1", updatedAt: null },
  });
  await expect(f.client.publications({ ...op, action: "complete", result })).rejects.toThrow(
    "must match",
  );
  await f.client.publications({
    ...op,
    action: "progress",
    progress: { ...progress, deploymentId: "deploy-1" },
  });
  await expect(
    f.client.publications({
      ...op,
      action: "complete",
      result: { ...result, state: "failed" } as unknown as PublicationSuccess,
    }),
  ).rejects.toThrow();
  await f.client.publications({ ...op, action: "complete", result });
  const next = f.operation("sites");
  expect(
    (
      await f.client.publications({
        ...next,
        action: "prepare",
        expectedRevision: 1,
        observation: observation({
          remoteId: result.remoteId,
          url: result.url,
          evidence: "authenticated-tool",
          marker: result.marker,
        }),
      })
    ).decision,
  ).toBe("warning");
});

test("refresh retains explicit approval only while destination facts are unchanged", async () => {
  const f = await fixture(),
    op = f.operation();
  const remote = observation({
    remoteId: "remote-1",
    url: "https://claude.ai/code/artifact/remote-1",
    evidence: "authenticated-share-inspection",
    marker: { version: "1", updatedAt: null },
  });
  expect(
    (
      await f.client.publications({
        ...op,
        action: "prepare",
        expectedRevision: 1,
        observation: remote,
      })
    ).decision,
  ).toBe("warning");
  await f.authorize(op);
  const refreshed = await f.client.publications({
    ...op,
    action: "refresh",
    observation: { ...remote, checkedAt: new Date().toISOString() },
  });
  expect(refreshed.decision).toBe("allowed");
  expect(refreshed.snapshot.destinations[0]?.operation?.state).toBe("prepared");
  const changed = await f.client.publications({
    ...op,
    action: "refresh",
    observation: {
      ...remote,
      checkedAt: new Date().toISOString(),
      marker: { version: "2", updatedAt: null },
    },
  });
  expect(changed.decision).toBe("warning");
  await expect(f.client.publications({ ...op, action: "start" })).rejects.toThrow("authorize");
  const blocked = await f.client.publications({
    ...op,
    action: "refresh",
    observation: { ...remote, checkedAt: new Date().toISOString(), audience: "public" },
  });
  expect(blocked.decision).toBe("blocked");
  expect(blocked.snapshot.destinations[0]?.operation?.state).toBe("blocked");
  expect((await f.client.publications({ action: "read", id: op.id })).decision).toBe("blocked");
  await expect(f.authorize(op)).rejects.toThrow("privacy");
});

test("a newer successful checkpoint cannot be replaced by replaying an older completion", async () => {
  const f = await fixture(),
    first = f.operation();
  await f.client.publications({
    ...first,
    action: "prepare",
    expectedRevision: 1,
    observation: observation(),
  });
  await f.client.publications({ ...first, action: "start" });
  const before = success();
  await f.client.publications({ ...first, action: "complete", result: before });
  const second = f.operation();
  await f.client.publications({
    ...second,
    action: "prepare",
    expectedRevision: 1,
    observation: observation({
      remoteId: before.remoteId,
      url: before.url,
      evidence: "authenticated-share-inspection",
      marker: before.marker,
    }),
  });
  await f.client.publications({ ...second, action: "start" });
  await f.client.publications({
    ...second,
    action: "complete",
    result: success({ marker: { version: "2", updatedAt: null } }),
  });
  await expect(
    f.client.publications({ ...first, action: "complete", result: before }),
  ).rejects.toThrow("not found");
  expect(
    (await f.client.publications({ action: "read", id: first.id })).snapshot.destinations[0]
      ?.checkpoint?.result.marker.version,
  ).toBe("2");
});

test("expired checks require refresh without losing approval", async () => {
  const f = await fixture(),
    op = f.operation();
  const remote = observation({
    remoteId: "remote-1",
    url: "https://claude.ai/code/artifact/remote-1",
    evidence: "authenticated-share-inspection",
    marker: { version: "1", updatedAt: null },
  });
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: remote,
  });
  await f.authorize(op);
  const db = new DatabaseSync(join(f.directory, "scope.db"));
  db.prepare(
    "UPDATE publications SET operation = json_set(operation, '$.observation.checkedAt', '2025-01-01T00:00:00Z') WHERE tab_id = ?",
  ).run(op.tabId);
  db.close();
  const read = await f.client.publications({ action: "read", id: op.id });
  expect(read.decision).toBe("allowed");
  expect(read.snapshot.destinations[0]?.operation?.needsRefresh).toBe(true);
  expect(read.snapshot.destinations[0]?.operation?.state).toBe("prepared");
  expect(read.snapshot.destinations[0]?.operation?.warnings).toContain(
    "The remote observation expired. Check the destination again before publishing.",
  );
  await expect(f.client.publications({ ...op, action: "start" })).rejects.toThrow();
  const refreshed = await f.client.publications({
    ...op,
    action: "refresh",
    observation: { ...remote, checkedAt: new Date().toISOString() },
  });
  expect(refreshed.snapshot.destinations[0]?.operation?.state).toBe("prepared");
  await f.client.publications({ ...op, action: "start" });
});

test("an expired safe overwrite warning remains acknowledgeable and requires a fresh check to start", async () => {
  const f = await fixture(),
    op = f.operation();
  const remote = observation({
    remoteId: "remote-1",
    url: "https://claude.ai/code/artifact/remote-1",
    evidence: "authenticated-share-inspection",
    marker: { version: "1", updatedAt: null },
  });
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: remote,
  });
  const db = new DatabaseSync(join(f.directory, "scope.db"));
  db.prepare(
    "UPDATE publications SET operation = json_set(operation, '$.observation.checkedAt', '2025-01-01T00:00:00Z') WHERE tab_id = ?",
  ).run(op.tabId);
  db.close();
  expect(
    (await f.client.publications({ action: "read", id: op.id })).snapshot.destinations[0]?.operation
      ?.state,
  ).toBe("warning");
  await f.authorize(op);
  await expect(f.client.publications({ ...op, action: "start" })).rejects.toThrow("Refresh");
  await f.client.publications({
    ...op,
    action: "refresh",
    observation: { ...remote, checkedAt: new Date().toISOString() },
  });
  await f.client.publications({ ...op, action: "start" });
});

test("confirmed Claude publication without change metadata saves its link and warns on the next update", async () => {
  const f = await fixture(),
    op = f.operation();
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: observation(),
  });
  await f.client.publications({ ...op, action: "start" });
  const result = success({ marker: { version: null, updatedAt: null } });
  const completed = await f.client.publications({ ...op, action: "complete", result });
  expect(completed.snapshot.destinations[0]?.checkpoint?.result.url).toBe(result.url);
  await f.restart();
  const next = f.operation();
  const update = await f.client.publications({
    ...next,
    action: "prepare",
    expectedRevision: 1,
    observation: observation({
      remoteId: result.remoteId,
      url: result.url,
      evidence: "authenticated-share-inspection",
    }),
  });
  expect(update.decision).toBe("warning");
  expect(update.messages.some((message) => message.includes("missing or incomparable"))).toBe(true);
});

test("stale acknowledgement cannot approve remote facts refreshed after the warning was displayed", async () => {
  const f = await fixture(),
    op = f.operation();
  const before = observation({
    remoteId: "remote-1",
    url: "https://claude.ai/code/artifact/remote-1",
    evidence: "authenticated-share-inspection",
    marker: { version: "1", updatedAt: null },
  });
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: before,
  });
  const after = {
    ...before,
    checkedAt: new Date().toISOString(),
    marker: { version: "2", updatedAt: null },
  };
  await f.client.publications({ ...op, action: "refresh", observation: after });
  await expect(
    f.client.publications({ ...op, action: "authorize", expectedObservation: before }),
  ).rejects.toThrow("check changed");
  await expect(f.client.publications({ ...op, action: "start" })).rejects.toThrow("authorize");
  await f.client.publications({ ...op, action: "authorize", expectedObservation: after });
  await f.client.publications({
    ...op,
    action: "refresh",
    observation: { ...after, checkedAt: new Date().toISOString() },
  });
  await f.client.publications({ ...op, action: "start" });
});

test("Sites creation retains an ID without a URL and fills its URL without replacing known identity", async () => {
  const f = await fixture(),
    op = f.operation("sites");
  await f.client.publications({
    ...op,
    action: "prepare",
    expectedRevision: 1,
    observation: observation({ evidence: "authenticated-tool" }),
  });
  await f.client.publications({ ...op, action: "start" });
  const created = {
    remoteId: "site-with-no-url",
    url: null,
    savedVersion: null,
    sourceCommit: null,
    deploymentId: null,
  };
  await f.client.publications({ ...op, action: "progress", progress: created });
  await f.restart();
  expect(
    (await f.client.publications({ action: "read", id: op.id })).snapshot.destinations[0]?.operation
      ?.progress,
  ).toEqual(created);
  await expect(
    f.client.publications({
      ...op,
      action: "progress",
      progress: { ...created, remoteId: "another-site" },
    }),
  ).rejects.toThrow("another destination");
  const saved = { ...created, savedVersion: "saved-version-1", sourceCommit: "b".repeat(40) };
  await f.client.publications({ ...op, action: "progress", progress: saved });
  const deployed = {
    ...saved,
    url: "https://site-with-no-url.chatgpt.site",
    deploymentId: "deployment-1",
  };
  await f.client.publications({ ...op, action: "progress", progress: deployed });
  await expect(
    f.client.publications({
      ...op,
      action: "progress",
      progress: { ...deployed, url: "https://different.chatgpt.site" },
    }),
  ).rejects.toThrow("another destination");
  await expect(
    f.client.publications({ ...op, action: "progress", progress: { ...deployed, url: null } }),
  ).rejects.toThrow("another destination");
  const result = success({
    ...deployed,
    provider: "sites",
    marker: {
      version: JSON.stringify({
        savedVersion: deployed.savedVersion,
        deploymentId: deployed.deploymentId,
      }),
      updatedAt: null,
    },
  });
  const invalid = await fetch(`${f.client.endpoint}/v1/publications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...op, action: "complete", result: { ...result, url: null } }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: "Invalid publication command." });
  const complete = await f.client.publications({ ...op, action: "complete", result });
  expect(complete.snapshot.destinations[0]?.checkpoint?.result).toEqual(result);
});

test("an explicitly cancelled Sites creation resumes the same project before its URL exists", async () => {
  const f = await fixture(),
    creating = f.operation("sites");
  await f.client.publications({
    ...creating,
    action: "prepare",
    expectedRevision: 1,
    observation: observation({ evidence: "authenticated-tool" }),
  });
  await f.client.publications({ ...creating, action: "start" });
  const created = {
    remoteId: "unpublished-existing-site",
    url: null,
    savedVersion: null,
    sourceCommit: null,
    deploymentId: null,
  };
  await f.client.publications({ ...creating, action: "progress", progress: created });
  await f.client.publications({ ...creating, action: "cancel", acknowledgeUncertain: true });
  const resumed = f.operation("sites");
  const remote = observation({
    remoteId: created.remoteId,
    url: null,
    evidence: "authenticated-tool",
    conditionalWrite: false,
  });
  const prepared = await f.client.publications({
    ...resumed,
    action: "prepare",
    expectedRevision: 1,
    observation: remote,
  });
  expect(prepared.decision).toBe("warning");
  await f.client.publications({ ...resumed, action: "authorize", expectedObservation: remote });
  const publishedUrl = "https://unpublished-existing-site.chatgpt.site";
  const withUrl = { ...remote, url: publishedUrl, checkedAt: new Date().toISOString() };
  const refreshed = await f.client.publications({
    ...resumed,
    action: "refresh",
    observation: withUrl,
  });
  expect(refreshed.decision).toBe("warning");
  await expect(f.client.publications({ ...resumed, action: "start" })).rejects.toThrow("authorize");
  await f.client.publications({ ...resumed, action: "authorize", expectedObservation: withUrl });
  await f.client.publications({ ...resumed, action: "start" });
  const progress = {
    ...created,
    url: publishedUrl,
    savedVersion: "saved-version-1",
    sourceCommit: "c".repeat(40),
    deploymentId: "deployment-1",
  };
  await f.client.publications({ ...resumed, action: "progress", progress });
  const result = success({
    ...progress,
    provider: "sites",
    marker: {
      version: JSON.stringify({
        savedVersion: progress.savedVersion,
        deploymentId: progress.deploymentId,
      }),
      updatedAt: null,
    },
  });
  const completed = await f.client.publications({ ...resumed, action: "complete", result });
  expect(completed.snapshot.destinations[0]?.checkpoint?.result.remoteId).toBe(created.remoteId);
  expect(completed.snapshot.destinations[0]?.checkpoint?.result.url).toBe(publishedUrl);
});
