import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LibrarianCommand, LibrarianReply } from "@irudd-scope/protocol/librarian";
import { desktopFixture } from "./desktop-fixture.ts";
import { memoryFixture } from "./memory-fixture.ts";

export const raw = (title: string, body: string) => `---
type: Memory
title: ${title}
memory: ${JSON.stringify({ id: title.toLowerCase().replaceAll(" ", "-"), kind: "procedural", stage: "bronze", applicability: { type: "global" } })}
---
${body}
`;
export const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
export async function librarianFixture(
  cleanup: (() => Promise<unknown> | void)[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const memory = await memoryFixture(cleanup);
  const root = join(memory.directory, "local-bundle");
  await mkdir(root);
  await writeFile(
    join(root, "memory-bundle.json"),
    JSON.stringify({ id: randomUUID(), formatVersion: 2, name: "personal" }),
  );
  await writeFile(join(root, "index.md"), "# Memory\n");
  await writeFile(join(root, "recovery.md"), raw("Recovery", "Retry interrupted work."));
  await writeFile(join(root, "validation.md"), raw("Validation", "Use synthetic fixtures."));
  const desktop = await desktopFixture({
    hideInitialPrompts: true,
    env: memory.env("local", { extra: options.env }),
  });
  cleanup.push(() => rm(desktop.directory, { recursive: true, force: true }));
  let application = await desktop.launch();
  cleanup.push(() => application.close());
  let page = await application.firstWindow();
  page.setDefaultTimeout(8000);
  let client = await desktop.connect();
  await client.librarian({ action: "local", root, initialize: false });
  const open = async () => {
    // The shortcut is handled once the workspace has rendered; a just-launched window may not have.
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("button", { name: "Librarian", exact: true }).click();
  };
  return {
    memory,
    root,
    desktop,
    get client() {
      return client;
    },
    open,
    get page() {
      return page;
    },
    get application() {
      return application;
    },
    restart: async (whileClosed?: () => Promise<void>) => {
      await application.close();
      await whileClosed?.();
      application = await desktop.launch();
      page = await application.firstWindow();
      page.setDefaultTimeout(8000);
      client = await desktop.connect();
    },
  };
}
export async function dreaming(
  f: Awaited<ReturnType<typeof librarianFixture>>,
  permissions: string[] | null = [],
) {
  let start!: LibrarianCommand;
  let reply!: LibrarianReply;
  // Opening Librarian loads its first page; like an agent, read again if that changed the view.
  for (let attempt = 1; ; attempt++) {
    const read = await f.client.librarian({ action: "read" });
    start = {
      action: "start",
      requestId: randomUUID(),
      expectedUiRevision: read.state.uiRevision,
      sessionId: "existing-session",
      userRequest: "Begin dreaming. Ask me about substantive changes.",
      ...(permissions ? { automaticPermissions: permissions } : {}),
    };
    try {
      reply = await f.client.librarian(start);
      break;
    } catch (error) {
      if (attempt === 3 || !/view changed/.test(String(error))) throw error;
    }
  }
  const capability = reply.capability!;
  const runId = reply.state.run!.id;
  async function propose(
    path: string,
    raw: string,
    disposition: "human" | "automatic" = "human",
    permission?: string,
    sources: { path: string; hash: string }[] = [],
  ) {
    const before = await readFile(join(f.root, path), "utf8").catch(() => null);
    reply = await f.client.librarian({
      action: "propose",
      requestId: randomUUID(),
      expectedUiRevision: reply.state.uiRevision,
      sessionId: "existing-session",
      capability,
      runId,
      path,
      raw,
      expectedHash: before === null ? null : hash(before),
      reason: `Improve ${path}`,
      sources,
      disposition,
      ...(permission ? { permission } : {}),
      evidence: `Evidence for ${path}`,
    });
    return reply;
  }
  return {
    start,
    capability,
    runId,
    propose,
    get reply() {
      return reply;
    },
    refresh: async () => (reply = await f.client.librarian({ action: "read" })),
  };
}

export const note = (
  title: string,
  memory: { kind: string; stage: string; applicability: object },
  tags: string[],
  body: string,
) =>
  `---\ntype: Memory\ntitle: ${title}\n${tags.length ? `tags: [${tags.join(", ")}]\n` : ""}memory: ${JSON.stringify({ id: title.toLowerCase().replaceAll(" ", "-"), ...memory })}\n---\n${body}\n`;
const global = { type: "global" };
/** Three linked synthetic memories across stages, kinds and applicability. */
export async function library(root: string) {
  await writeFile(
    join(root, "deploy.md"),
    note(
      "Deploy steps",
      { kind: "procedural", stage: "silver", applicability: global },
      ["deploy", "ci"],
      "Run the deploy. See [Retry rule](retry.md) and [Gone](gone.md).",
    ),
  );
  await writeFile(
    join(root, "retry.md"),
    note(
      "Retry rule",
      { kind: "semantic", stage: "bronze", applicability: { type: "repository", id: "atlas" } },
      ["ci"],
      "Deploys can need one retry. Back to [Deploy steps](deploy.md).",
    ),
  );
  await mkdir(join(root, "notes"));
  await writeFile(
    join(root, "notes", "old.md"),
    note(
      "Old episode",
      { kind: "episodic", stage: "bronze", applicability: { type: "machine", id: "studio" } },
      [],
      "An episode on one machine. See [Retry rule](../retry.md).",
    ),
  );
}
