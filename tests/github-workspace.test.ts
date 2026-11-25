import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { WorkspaceSnapshot } from "@irudd-scope/protocol/workspace";
import { desktopFixture } from "./desktop-fixture.ts";

test(
  "a workspace tab unifies PRs, issues, relations, and an optional board through gh, preserves local edits, and survives restart",
  { tags: ["pr-inbox-keeps-local-work", "survives-restart", "no-lost-updates"], timeout: 60_000 },
  async () => {
    const ghDirectory = await mkdtemp(join(tmpdir(), "scope-workspace-gh-"));
    const stateFile = join(ghDirectory, "state.json");
    const callsFile = join(ghDirectory, "calls.jsonl");
    const head = "a".repeat(40);
    const base = "b".repeat(40);

    await writeFile(
      stateFile,
      JSON.stringify({
        boardUpdatedAt: "2026-11-25T07:00:00Z",
        statusName: "Todo",
        blockedByCount: 0,
        blockedByIds: [] as string[],
        prState: "OPEN",
        missingScope: false,
      }),
    );

    const scriptFile = join(ghDirectory, "gh-fake.mjs");
    await writeFile(
      scriptFile,
      `import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : "";
const parsed = stdin ? JSON.parse(stdin) : null;
const query = parsed?.query ?? "";
const queryName = /query\\s+(\\w+)/.exec(query)?.[1] ?? args.join(" ");
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(queryName) + "\\n");

const common = {
  viewer: { login: "viewer" },
  rateLimit: { cost: 1, limit: 5000, remaining: 4990, resetAt: "2099-11-25T08:00:00Z" },
};
const pageInfo = { hasNextPage: false, endCursor: null };
const prNode = {
  id: "PR_1",
  number: 34,
  title: "feat: incremental invoice poller",
  state: state.prState,
  isDraft: false,
  url: "https://github.com/synthetic/project/pull/34",
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-25T07:00:00Z",
  mergedAt: state.prState === "MERGED" ? "2026-11-25T07:30:00Z" : null,
  closedAt: state.prState === "MERGED" ? "2026-11-25T07:30:00Z" : null,
  headRefOid: "${head}",
  headRefName: "feat/poller",
  baseRefOid: "${base}",
  additions: 24,
  deletions: 4,
  changedFiles: 1,
  mergeable: "MERGEABLE",
  author: { login: "alice" },
  milestone: { id: "M_1" },
  labels: { nodes: [{ name: "priority:high" }] },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "viewer" } }] },
  reviewDecision: "APPROVED",
  latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] },
  reviewThreads: { nodes: [{ isResolved: true }] },
  commits: { nodes: [{ commit: { oid: "${head}", statusCheckRollup: { state: "SUCCESS", commit: { oid: "${head}" } } } }] },
  closingIssuesReferences: { nodes: [{ id: "I_SUB" }] },
  isMergeQueueEnabled: false,
  mergeQueue: null,
  mergeQueueEntry: null,
};
const parentSlim = {
  id: "I_PARENT",
  number: 18,
  title: "Production environment provisioning",
  state: "OPEN",
  stateReason: null,
  url: "https://github.com/synthetic/project/issues/18",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-24T10:00:00Z",
  closedAt: null,
  author: { login: "alice" },
  issueType: { id: "IT_1", name: "Task" },
  milestone: { id: "M_1" },
  parent: null,
  subIssuesSummary: { total: 1, completed: 1, percentCompleted: 100 },
  issueDependenciesSummary: { blockedBy: state.blockedByCount, blocking: 0 },
};
const subSlim = {
  id: "I_SUB",
  number: 19,
  title: "Provision prod DB",
  state: "CLOSED",
  stateReason: "COMPLETED",
  url: "https://github.com/synthetic/project/issues/19",
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt: "2026-11-24T12:00:00Z",
  closedAt: "2026-11-24T12:00:00Z",
  author: { login: "alice" },
  issueType: null,
  milestone: null,
  parent: { id: "I_PARENT" },
  subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 },
  issueDependenciesSummary: { blockedBy: 0, blocking: state.blockedByCount },
};

if (query.includes("WorkspaceOpenPRs")) {
  console.log(JSON.stringify({
    data: {
      ...common,
      repository: {
        id: "R_1",
        owner: { login: "synthetic" },
        name: "project",
        nameWithOwner: "synthetic/project",
        pullRequests: { pageInfo, nodes: state.prState === "OPEN" ? [prNode] : [] },
      },
    },
  }));
} else if (query.includes("WorkspacePRsByIds")) {
  console.log(JSON.stringify({ data: { ...common, nodes: [prNode] } }));
} else if (query.includes("WorkspaceRepoDelta")) {
  if (state.missingScope && parsed?.variables?.includeBoard) {
    console.log(JSON.stringify({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "The 'projectV2' field requires ['read:project']" }] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    data: {
      ...common,
      repository: {
        id: "R_1",
        owner: { login: "synthetic" },
        name: "project",
        nameWithOwner: "synthetic/project",
        milestones: {
          nodes: [{
            id: "M_1", number: 1, title: "1st prio - Production", description: "", state: "OPEN",
            dueOn: "2026-12-15T23:59:59Z", updatedAt: "2026-11-20T00:00:00Z",
            open: { totalCount: 1 }, closed: { totalCount: 1 },
          }],
        },
        issues: { pageInfo, nodes: [parentSlim, subSlim] },
      },
      userBoard: { projectV2: { id: "PVT_1", updatedAt: state.boardUpdatedAt } },
    },
  }));
} else if (query.includes("WorkspaceOpenIssuesSweep")) {
  console.log(JSON.stringify({
    data: { ...common, repository: { issues: { pageInfo, nodes: [parentSlim] } } },
  }));
} else if (query.includes("WorkspaceHydrateIssues")) {
  const map = {
    I_PARENT: {
      ...parentSlim,
      assignees: { nodes: [{ login: "alice" }] },
      labels: { nodes: [{ name: "agent-plan" }] },
      blockedBy: { nodes: state.blockedByIds.map((id) => ({ id })) },
      blocking: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [] },
    },
    I_SUB: {
      ...subSlim,
      assignees: { nodes: [] },
      labels: { nodes: [] },
      blockedBy: { nodes: [] },
      blocking: { nodes: [] },
      closedByPullRequestsReferences: { nodes: [prNode] },
    },
  };
  const nodes = (parsed?.variables?.ids ?? []).map((id) => map[id]).filter(Boolean);
  console.log(JSON.stringify({ data: { ...common, nodes } }));
} else if (query.includes("WorkspaceBoardSchema")) {
  console.log(JSON.stringify({
    data: {
      ...common,
      userBoard: {
        projectV2: {
          id: "PVT_1", number: 3, title: "Synthetic Board",
          url: "https://github.com/users/synthetic/projects/3",
          updatedAt: state.boardUpdatedAt,
          fields: {
            nodes: [{
              id: "PVTF_STATUS", name: "Status", dataType: "SINGLE_SELECT",
              options: [
                { id: "OPT_TODO", name: "Todo", color: "GREEN", description: "" },
                { id: "OPT_DONE", name: "Done", color: "BLUE", description: "" },
              ],
            }],
          },
          views: { nodes: [{ id: "PVTV_1", number: 1, name: "Board", layout: "BOARD_LAYOUT", filter: "-status:Done" }] },
        },
      },
    },
  }));
} else if (query.includes("WorkspaceBoardItems")) {
  console.log(JSON.stringify({
    data: {
      ...common,
      userBoard: {
        projectV2: {
          id: "PVT_1",
          updatedAt: state.boardUpdatedAt,
          items: {
            pageInfo,
            nodes: [{
              id: "PVTI_1", type: "ISSUE", isArchived: false,
              createdAt: "2026-11-01T10:00:00Z", updatedAt: state.boardUpdatedAt,
              content: { __typename: "Issue", id: "I_PARENT" },
              fieldValues: {
                nodes: [{
                  __typename: "ProjectV2ItemFieldSingleSelectValue",
                  name: state.statusName,
                  optionId: state.statusName === "Done" ? "OPT_DONE" : "OPT_TODO",
                  updatedAt: state.boardUpdatedAt,
                  field: { id: "PVTF_STATUS", name: "Status" },
                }],
              },
            }],
          },
        },
      },
    },
  }));
} else if (query.includes("WorkspaceIssueDetail")) {
  console.log(JSON.stringify({
    data: {
      ...common,
      node: {
        id: "I_PARENT",
        body: "Tracker description",
        comments: { nodes: [] },
        timelineItems: { nodes: [{ __typename: "MilestonedEvent", createdAt: "2026-11-20T00:00:00Z", actor: { login: "alice" }, milestoneTitle: "1st prio - Production" }] },
      },
    },
  }));
} else if (query.includes("WorkspacePRView")) {
  console.log(JSON.stringify({
    data: { ...common, repository: { pullRequest: { id: "PR_1", state: "OPEN", headRefOid: "${head}", baseRefOid: "${base}", body: "PR body" } } },
  }));
} else if (args[0] === "pr" && args[1] === "diff") {
  console.log("diff --git a/a.ts b/a.ts\\n+hello\\n");
} else if (args.some((a) => a.includes("/files?"))) {
  console.log(JSON.stringify([{ filename: "a.ts", sha: "${head}", additions: 1, deletions: 0, status: "modified" }]));
} else if (args.some((a) => a.includes("/reviews?"))) {
  console.log(JSON.stringify([]));
} else if (args.includes("user")) {
  console.log(JSON.stringify({ login: "viewer" }));
} else {
  console.error("Unexpected fake gh call:", args.join(" "));
  process.exit(1);
}
`,
    );

    if (process.platform === "win32") {
      await writeFile(
        join(ghDirectory, "gh.cmd"),
        `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`,
      );
    } else {
      await writeFile(
        join(ghDirectory, "gh"),
        `#!/bin/sh\nexec "${process.execPath}" "${scriptFile}" "$@"\n`,
        {
          mode: 0o700,
        },
      );
    }

    const fixture = await desktopFixture({
      hideInitialPrompts: true,
      env: { PATH: `${ghDirectory}${delimiter}${process.env.PATH ?? ""}` },
    });

    let app = await fixture.launch();
    try {
      const page = await app.firstWindow();
      page.setDefaultTimeout(10_000);

      // 1. Publish workspace HTML tab & configure repo + Project v2 board
      const html = `<!doctype html><html><body><div id="status">loading</div><script>
        window.scope.workspace.watch((snap) => {
          document.getElementById("status").textContent =
            "issues=" + snap.issues.length + ",prs=" + snap.pullRequests.length + ",board=" + (snap.board ? snap.board.items.length : 0);
        });
      </script></body></html>`;

      await page.evaluate(async (doc) => {
        await window.scope.createWorkspace({
          name: "synthetic-board",
          title: "Synthetic Board",
          html: doc,
          repository: { owner: "synthetic", name: "project" },
          board: { owner: "synthetic", ownerType: "user", number: 3 },
        });
      }, html);

      // 2. Trigger sync and verify unified snapshot + iframe rendering
      const snap1 = await page.evaluate(async () => {
        const current = await window.scope.workspaceCommand({
          action: "read",
          name: "synthetic-board",
        });
        if (current.type !== "snapshot") throw new Error("expected snapshot");
        const synced = await window.scope.workspaceCommand({
          action: "sync",
          name: "synthetic-board",
          tabId: current.snapshot.tabId,
          requestId: crypto.randomUUID(),
        });
        if (synced.type !== "snapshot") throw new Error("expected snapshot");
        return synced.snapshot;
      });
      expect(snap1.milestones).toHaveLength(1);
      expect(snap1.issues).toHaveLength(2);
      expect(snap1.prs).toHaveLength(1);
      expect(snap1.board?.items).toHaveLength(1);
      expect(
        snap1.issues.find((i) => i.nodeId === "I_PARENT")?.subIssuesSummary.percentCompleted,
      ).toBe(100);

      const frame = page.frameLocator('iframe[title="Synthetic Board"]');
      await expect
        .poll(() => frame.locator("#status").textContent())
        .toBe("issues=2,prs=1,board=1");

      // 3. Save local note + appState + verify stale version conflict fails cleanly
      await page.evaluate(async (tabId) => {
        await window.scope.workspaceCommand({
          action: "note",
          name: "synthetic-board",
          tabId,
          requestId: crypto.randomUUID(),
          nodeId: "I_PARENT",
          expectedVersion: 0,
          text: "100% done — close parent!",
        });
        await window.scope.workspaceCommand({
          action: "state-set",
          name: "synthetic-board",
          tabId,
          requestId: crypto.randomUUID(),
          expectedVersion: 0,
          value: { groupBy: "milestone" },
        });
      }, snap1.tabId);

      const conflictError = await page.evaluate(async (tabId) => {
        try {
          await window.scope.workspaceCommand({
            action: "note",
            name: "synthetic-board",
            tabId,
            requestId: crypto.randomUUID(),
            nodeId: "I_PARENT",
            expectedVersion: 0,
            text: "stale overwrite",
          });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }, snap1.tabId);
      expect(conflictError).toMatch(/Note changed/i);

      // 4. Mutate upstream: silent blockedBy (Issue.updatedAt UNCHANGED!), board Status Todo -> Done, PR #34 MERGED
      await writeFile(
        stateFile,
        JSON.stringify({
          boardUpdatedAt: "2026-11-25T07:45:00Z",
          statusName: "Done",
          blockedByCount: 1,
          blockedByIds: ["I_SUB"],
          prState: "MERGED",
          missingScope: false,
        }),
      );

      const snap2: WorkspaceSnapshot = await page.evaluate(async (tabId) => {
        const res = await window.scope.workspaceCommand({
          action: "sync",
          name: "synthetic-board",
          tabId,
          requestId: crypto.randomUUID(),
        });
        if (res.type !== "snapshot") throw new Error("expected snapshot");
        return res.snapshot;
      }, snap1.tabId);

      // Verify silent blockedBy was caught by open-issue sweep, merged PR was retained, and transitions were emitted!
      const parent2 = snap2.issues.find((i) => i.nodeId === "I_PARENT")!;
      expect(parent2.blockedByIds).toEqual(["I_SUB"]);
      expect(parent2.local.note).toBe("100% done — close parent!");
      expect(snap2.prs.find((p) => p.nodeId === "PR_1")?.state).toBe("merged");
      const kinds = snap2.transitions.map((t) => t.kind);
      expect(kinds).toContain("issue.blocked-by-changed");
      expect(kinds).toContain("pr.merged");
      expect(kinds).toContain("board.field-changed");

      // 5. Verify on-demand issueDetail + restart persistence
      const issueDet = await page.evaluate(async (tabId) => {
        const res = await window.scope.workspaceCommand({
          action: "issue-detail",
          name: "synthetic-board",
          tabId,
          requestId: crypto.randomUUID(),
          nodeId: "I_PARENT",
        });
        if (res.type !== "issue-detail") throw new Error("expected issue-detail");
        return res.detail;
      }, snap1.tabId);
      expect(issueDet.body).toBe("Tracker description");
      expect(issueDet.timeline).toHaveLength(1);

      await app.close();
      app = await fixture.launch();
      const page2 = await app.firstWindow();
      page2.setDefaultTimeout(10_000);
      const afterRestart = await page2.evaluate(async () => {
        const res = await window.scope.workspaceCommand({
          action: "read",
          name: "synthetic-board",
        });
        if (res.type !== "snapshot") throw new Error("expected snapshot");
        return res.snapshot;
      });
      expect(afterRestart.issues.find((i) => i.nodeId === "I_PARENT")?.local.note).toBe(
        "100% done — close parent!",
      );
      expect(afterRestart.appState?.value).toEqual({ groupBy: "milestone" });
      expect(afterRestart.board?.items[0]?.fieldValues[0]?.text).toBe("Done");

      const calls = (await readFile(callsFile, "utf8")).trim().split("\n");
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      await app.close().catch(() => {});
      await rm(fixture.directory, { recursive: true, force: true }).catch(() => {});
      await rm(ghDirectory, { recursive: true, force: true }).catch(() => {});
    }
  },
);
