import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { Session, check, until } from "./session.ts";
import type { Fixtures } from "./artifacts.ts";
import { memoryRaw } from "./fixtures.ts";
import { rows } from "./report.ts";
import type { RetroReport } from "@irudd-scope/protocol/retro";

export async function seedPrompts(s: Session, f: Fixtures, count: number) {
  const client = await s.client();
  for (let i = f.promptCount; i < count; i++) {
    const id = f.promptIds[i];
    await client.prompts({
      action: "create-item",
      id,
      expectedRevision: 0,
      requestId: randomUUID(),
      item: {
        type: "text-to-image",
        structureId: "text-to-image-seven",
        structureVersion: 1,
        field: "subject",
        name: `Performance subject ${i}`,
        fragment: `synthetic subject ${i}`,
        description: "Synthetic benchmark",
        exampleScene: { title: "Performance scene", prompt: "A synthetic scene" },
      },
    });
  }
  if (f.promptCount === 0)
    await client.prompts({
      action: "set-image",
      id: f.promptIds[0],
      expectedRevision: 1,
      requestId: randomUUID(),
      image: {
        mediaType: "image/png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      },
    });
  f.promptCount = count;
}
export async function scaleLibraries(s: Session, f: Fixtures, count: number) {
  const client = await s.client();
  for (let i = count; i < f.promptCount; i++) {
    const reply = await client.prompts({ action: "read-item", id: f.promptIds[i] });
    check(reply.type === "item", "Expected prompt item");
    await client.prompts({
      action: "delete-item",
      id: f.promptIds[i],
      expectedRevision: reply.item.revision,
      requestId: randomUUID(),
    });
    f.promptIds[i] = randomUUID();
  }
  f.promptCount = Math.min(f.promptCount, count);
  await seedPrompts(s, f, count);
  for (let i = Math.min(count, f.memoryCount); i < Math.max(count, f.memoryCount); i++) {
    const name = `note-${String(i).padStart(4, "0")}.md`;
    await rename(
      join(count > f.memoryCount ? f.reserve : f.root, name),
      join(count > f.memoryCount ? f.root : f.reserve, name),
    );
  }
  f.memoryCount = count;
  s.report.event("workload", {
    phase: s.phase,
    workload: s.workload,
    promptCount: f.promptCount,
    memoryCount: f.memoryCount,
  });
}
export async function prompts(s: Session) {
  s.feature = "prompts.current-library-image-export";
  const client = await s.client();
  await s.run("picker-image-use", "interaction", async () => {
    await s.open("Prompts");
    await s.page.getByRole("button", { name: "Choose Subject", exact: true }).click();
    await s.page
      .getByLabel("Search Subject library", { exact: true })
      .fill("Performance subject 0");
    await s.page
      .getByRole("button", { name: "Use Performance subject 0", exact: true })
      .scrollIntoViewIfNeeded();
    await s.page
      .getByRole("img", { name: "Performance scene" })
      .first()
      .evaluate(async (node) => {
        await (node as HTMLImageElement).decode();
      });
    await s.page.getByRole("button", { name: "Use Performance subject 0", exact: true }).click();
    await until(
      () => s.page.getByRole("textbox", { name: "Subject", exact: true }).inputValue(),
      (value) => value === "synthetic subject 0",
    );
  });
  const text = "Edited synthetic subject";
  await s.run("edit-save-current", "interaction", async () => {
    await s.page.getByRole("textbox", { name: "Subject", exact: true }).fill(text);
    await until(
      () => client.prompts({ action: "read-workspace" }),
      (value) => value.type === "workspace" && value.workspace.document.parts.subject.text === text,
    );
    await s.page
      .getByRole("region", { name: "Combined prompt", exact: true })
      .getByText(/Edited synthetic subject/)
      .waitFor();
  });
  await s.run("reset-undo", "interaction", async () => {
    await s.page.getByRole("button", { name: "Reset", exact: true }).click();
    await s.page.getByRole("button", { name: "Undo", exact: true }).click();
    check(
      (await s.page.getByRole("textbox", { name: "Subject", exact: true }).inputValue()) === text,
      "Prompt undo lost edits",
    );
  });
  const output = join(s.report.directory, "data", "prompt-export.zip");
  const zip = await s.run("export-library", "api", () => client.exportPromptLibrary());
  check(zip.length > 0, "Empty prompt export");
  await writeFile(output, zip);
  s.status(
    s.feature,
    "measured",
    "Current editor autosave/reset/undo; library selection and decoded image; real ZIP API export. Native save dialog excluded.",
  );
}
export async function librarian(s: Session, f: Fixtures, native: boolean) {
  s.feature = "librarian.browse-search-read";
  const client = await s.client();
  await s.run("navigate-browse", "ipc", () =>
    s.page.evaluate(async () => {
      const state = await window.scope.librarianRead();
      await window.scope.librarianHuman({
        action: "navigate",
        requestId: crypto.randomUUID(),
        expectedUiRevision: state.uiRevision,
        view: "browse",
        query: "",
        directory: "",
        offset: 0,
      });
    }),
  );
  await s.run("browse-search-read", "interaction", async () => {
    await s.open("Librarian");
    const search = s.page.getByRole("textbox", { name: "Search memory", exact: true });
    await search.fill("Synthetic performance memory 0.");
    await s.page.getByRole("button", { name: "Search memory", exact: true }).click();
    await s.page.getByRole("button", { name: "Performance memory 0", exact: true }).click();
    await s.page
      .locator(".memory-wiki")
      .getByText("Synthetic performance memory 0.", { exact: true })
      .waitFor();
  });
  s.status(
    s.feature,
    "measured",
    native
      ? "Native OKF against isolated synthetic local bundle; external timings logged"
      : "Synthetic OKF integration; native engine latency unmeasured",
  );
  s.feature = "librarian.proposals-decisions-completion";
  const raw = memoryRaw(0, "Reviewed synthetic update.");
  const before = await readFile(join(f.root, "note-0000.md"), "utf8");
  await s.run("propose-accept-finish", "interaction", async () => {
    const initial = await client.librarian({ action: "read" });
    const started = await client.librarian({
      action: "start",
      requestId: randomUUID(),
      expectedUiRevision: initial.state.uiRevision,
      sessionId: "performance",
      userRequest: "Review synthetic memory",
      automaticPermissions: [],
    });
    const connection = {
      runId: started.state.run!.id,
      capability: started.capability!,
      sessionId: "performance",
    };
    await client.librarian({
      action: "propose",
      ...connection,
      requestId: randomUUID(),
      expectedUiRevision: started.state.uiRevision,
      path: "note-0000.md",
      raw,
      expectedHash: createHash("sha256").update(before).digest("hex"),
      reason: "Synthetic proposal",
      sources: [],
      disposition: "human",
      evidence: "Generated benchmark input",
    });
    await s.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
    await until(
      () => client.librarian({ action: "read" }),
      (reply) => reply.state.pendingCount === 0 && (reply.state.completedCount ?? 0) > 0,
    );
    check(
      (await readFile(join(f.root, "note-0000.md"), "utf8")).includes("Reviewed synthetic update"),
      "Accepted memory not persisted",
    );
    await s.page.getByRole("button", { name: "Inspect completed changes", exact: true }).click();
    await s.page.getByRole("button", { name: "Performance memory 0", exact: true }).click();
    await s.page
      .locator(".memory-wiki")
      .getByText(/Reviewed synthetic update/)
      .waitFor();
    await client.librarian({
      action: "finish",
      ...connection,
      requestId: randomUUID(),
      expectedUiRevision: (await client.librarian({ action: "read" })).state.uiRevision,
      userRequest: "Finish synthetic review",
    });
    const finished = await client.librarian({ action: "read" });
    check(finished.state.run?.status === "completed", "Librarian run did not complete");
  });
  // Keep the next equivalent browse input identical.
  await writeFile(join(f.root, "note-0000.md"), memoryRaw(0));
  s.status(
    s.feature,
    "measured",
    native
      ? "Real native write plus Scope proposal/review/completed state"
      : "Synthetic OKF write integration plus real Scope decision state",
  );
}
export async function pullRequests(s: Session, knownDelay = false) {
  s.feature = knownDelay
    ? "external-delay-attribution"
    : "pull-requests.inventory-detail-state-windows";
  const client = await s.client();
  await s.run(knownDelay ? "known-delay-sync" : "inventory-sync", "interaction", async () => {
    await s.open("Performance inbox");
    const back = s.page
      .frameLocator(".pull-requests-document")
      .getByRole("button", { name: "← Back to inbox", exact: true });
    if (await back.isVisible()) await back.click();
    const reply = await client.pullRequests({ action: "read", name: "performance-pr" });
    check(reply.type === "snapshot", "Expected PR snapshot");
    await client.pullRequests({
      action: "sync",
      name: "performance-pr",
      tabId: reply.snapshot.tabId,
      requestId: randomUUID(),
    });
    await s.page
      .frameLocator(".pull-requests-document")
      .getByRole("button", { name: "View changed files for #1", exact: true })
      .waitFor();
  });
  if (knownDelay) {
    const externalRows = rows(s.report.directory, "external.jsonl");
    const operations = rows(s.report.directory, "events.jsonl").filter(
      (row) => row.operation === "known-delay-sync" && row.type === "operation",
    );
    const external = externalRows.filter(
      (row) => row.id === operations.at(-1)?.id && row.type === "external-end",
    );
    check(
      external.some((row) => Number(row.injectedDelayMs) === 250 && Number(row.durationMs) >= 250),
      "Injected external delay missing from attribution",
    );
    check(Number(operations.at(-1)?.durationMs) >= 250, "End-to-end timing did not include delay");
    s.report.event("attribution", {
      feature: s.feature,
      externalIntervals: external.map((row) => ({
        id: row.externalId,
        start: row.invokedAt,
        end: row.completedAt,
        durationMs: row.durationMs,
        injectedDelayMs: row.injectedDelayMs,
      })),
      interactionMs: operations.at(-1)?.durationMs,
      conclusion:
        "Known delay observed in external command intervals; remaining interaction time is unattributed",
    });
    s.status(
      s.feature,
      "measured",
      "250ms per-command injected GitHub delay appears separately from interaction duration",
    );
    return;
  }
  const frame = s.page.frameLocator(".pull-requests-document");
  await s.run("detail-note-state", "interaction", async () => {
    await frame.getByRole("button", { name: "Performance review", exact: true }).click();
    await frame.getByText("Synthetic performance details", { exact: true }).waitFor();
    await frame.getByLabel("Your notes").fill("Synthetic performance note");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText("Saved", { exact: true }).waitFor();
  });
  await s.run("open-diff-window", "interaction", async () => {
    await frame.getByRole("button", { name: "Diff", exact: true }).click();
    await s.page.frameLocator(".scope-content-document").getByText("new value").waitFor();
    const dialog = s.page.getByRole("dialog", { name: "Changes in #1" });
    await dialog.getByRole("button", { name: "Maximize content window" }).click();
    await dialog.getByRole("button", { name: "Restore content window" }).click();
    await dialog.getByRole("button", { name: "Close content window" }).click();
    await frame.getByRole("button", { name: "← Back to inbox", exact: true }).click();
  });
  s.status(
    s.feature,
    "measured",
    "Real inbox inventory/detail/local note and diff window with deterministic synthetic gh",
  );
}
export async function sketchpad(s: Session) {
  s.feature = "sketchpad.edit-autosave-present";
  await s.open("Sketchpad");
  await s.page.getByTestId("main-menu-trigger").waitFor();
  const id = (await s.page
    .getByRole("tab", { name: "Sketchpad", exact: true })
    .getAttribute("id"))!.slice(4);
  const previous = await s.page.evaluate((id) => window.scope.sketchpadDraft(id), id);
  const previousIds = new Set<string>(
    previous
      ? JSON.parse(previous.content).elements.map((element: { id: string }) => element.id)
      : [],
  );
  await s.page.getByTestId("main-menu-trigger").click();
  await s.page.getByRole("button", { name: "Reset canvas", exact: true }).click();
  await s.open("Performance text");
  await until(
    () => s.page.evaluate((id) => window.scope.sketchpadDraft(id), id),
    (value) => value === null,
  );
  await s.open("Sketchpad");
  await s.page.getByTestId("main-menu-trigger").waitFor();
  await s.run("draw-autosave", "interaction", async () => {
    await s.page.locator(".excalidraw canvas.interactive").click({ position: { x: 300, y: 250 } });
    await s.page.keyboard.press("r");
    await s.page.mouse.move(300, 250);
    await s.page.mouse.down();
    await s.page.mouse.move(460, 360);
    await s.page.mouse.up();
    await until(
      () => s.page.evaluate((id) => window.scope.sketchpadDraft(id), id),
      (draft) => {
        if (!draft) return false;
        const elements = JSON.parse(draft.content).elements as {
          id: string;
          type: string;
          isDeleted?: boolean;
          width: number;
          height: number;
        }[];
        const active = elements.filter((element) => !element.isDeleted);
        return (
          active.length === 1 &&
          active[0].type === "rectangle" &&
          !previousIds.has(active[0].id) &&
          active[0].width > 0 &&
          active[0].height > 0
        );
      },
    );
  });
  await s.run("present-and-return", "interaction", async () => {
    await s.page.getByRole("button", { name: "Search and controls" }).click();
    await s.page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const mode = s.page.getByRole("combobox", { name: "Fullscreen Sketchpad mode" });
    await mode.selectOption("view");
    await mode.selectOption("present");
    await s.page.mouse.move(250, 250, { steps: 5 });
    await until(
      () => s.page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
      (value) => value === "1",
    );
    await s.page.keyboard.press("Escape");
    await mode.selectOption("tabs");
  });
  s.status(
    s.feature,
    "measured",
    "Real canvas pointer edit, persisted draft and fullscreen view/present",
  );
}
export async function retro(s: Session) {
  s.feature = "retro.reports";
  const client = await s.client();
  const report: RetroReport = {
    summary: "Synthetic performance retrospective",
    agent: { sourceId: "local", runtime: "codex", sessionId: "synthetic" },
    sources: [],
    destinations: [],
    findings: [
      {
        id: "synthetic",
        category: "efficiency",
        title: "Synthetic finding",
        text: "Generated performance fixture",
        evidence: ["Synthetic input"],
        sessions: [],
      },
    ],
    metrics: [],
  };
  await s.run("publish-visible-report", "interaction", async () => {
    await s.open("Performance retro");
    const reply = await client.retro({ action: "read", name: "performance-retro" });
    check(reply.type === "snapshot", "Expected retro snapshot");
    await client.retro({
      action: "publish",
      name: "performance-retro",
      tabId: reply.snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: reply.snapshot.version,
      report,
    });
    await s.page
      .frameLocator(".retro-document")
      .getByRole("heading", { name: "Synthetic finding", exact: true })
      .waitFor();
  });
  s.status(
    s.feature,
    "measured",
    "Real report API publication and visible report. Real session discovery/SSH excluded.",
  );
}
