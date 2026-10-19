import { Session, check, until } from "./session.ts";
import type { fixtures } from "./fixtures.ts";
export type Fixtures = Awaited<ReturnType<typeof fixtures>>;
export const kinds = ["text", "markdown", "html", "image", "file", "excalidraw"];
export async function seedArtifacts(s: Session, f: Fixtures) {
  for (const kind of kinds)
    await s.cli("add", f.files[kind], "--id", `perf-${kind}`, "--title", `Performance ${kind}`);
  await s.cli("add", f.files.large, "--id", "perf-large", "--title", "Performance large");
  await s.cli(
    "add",
    f.files.plan,
    "--plan",
    "--name",
    "performance-plan",
    "--title",
    "Performance plan",
  );
  await s.cli(
    "add",
    f.files["pull-requests"],
    "--pull-requests",
    "--name",
    "performance-pr",
    "--title",
    "Performance inbox",
  );
  await s.cli("pull-requests", "configure", "performance-pr", "synthetic/project");
  await s.cli(
    "add",
    f.files.retro,
    "--retro",
    "--name",
    "performance-retro",
    "--title",
    "Performance retro",
  );
}
export async function viewers(s: Session) {
  for (const kind of [...kinds, "large"]) {
    s.feature = `viewers.${kind}`;
    await s.run("search-open-visible", "interaction", async () => {
      await s.open(`Performance ${kind}`);
      const pane = s.page.getByRole("tabpanel", { name: `Performance ${kind}`, exact: true });
      if (kind === "html")
        await pane
          .frameLocator("iframe")
          .getByRole("heading", { name: "Synthetic preview" })
          .waitFor();
      else if (kind === "image") {
        await pane.locator("img").waitFor();
        check(
          await pane
            .locator("img")
            .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          "Image did not decode",
        );
      } else if (kind === "file" || kind === "excalidraw")
        await pane
          .getByRole("heading", {
            name: kind === "file" ? "data.bin" : "diagram.excalidraw",
            exact: true,
          })
          .waitFor();
      else if (kind === "large")
        await pane.getByRole("heading", { name: "Large performance note" }).waitFor();
      else await pane.locator(kind === "markdown" ? "article" : "pre").waitFor();
    });
    s.status(
      s.feature,
      "measured",
      "Search to visible real viewer completion, including two animation frames",
    );
  }
  s.feature = "plans";
  await s.run("open-plan", "interaction", async () => {
    await s.open("Performance plan");
    await s.page
      .frameLocator(".plan-document")
      .getByRole("heading", { name: "Performance plan" })
      .waitFor();
  });
  s.status(s.feature, "measured", "Named plan published through built CLI and opened visibly");
}
export async function publications(s: Session, f: Fixtures) {
  s.feature = "publication.direct";
  const client = await s.client();
  await s.run("api-list", "api", async () =>
    check(
      (await client.list()).some((item) => item.id === "perf-text"),
      "Published text missing",
    ),
  );
  await s.run("selected-update-visible", "interaction", async () => {
    await s.open("Performance text");
    const current = await client.get("perf-text");
    await client.publish(
      current.id,
      {
        title: current.title,
        kind: current.kind,
        mediaType: current.mediaType,
        fileName: current.fileName,
        expectedRevision: current.revision,
      },
      new TextEncoder().encode("Visible synthetic update"),
    );
    await s.page
      .getByRole("tabpanel", { name: "Performance text" })
      .getByText("Visible synthetic update", { exact: true })
      .waitFor();
  });
  await s.run("hidden-update", "api", async () => {
    const current = await client.get("perf-markdown");
    await client.publish(
      current.id,
      {
        title: current.title,
        kind: current.kind,
        mediaType: current.mediaType,
        fileName: current.fileName,
        expectedRevision: current.revision,
      },
      new TextEncoder().encode("# Hidden synthetic update\n"),
    );
  });
  await s.cli("update", "perf-text", f.files.text);
  s.status(
    s.feature,
    "measured",
    "Built CLI publication/update, HTTP list and selected/hidden updates",
  );
}
export async function tabs(s: Session) {
  s.feature = "workspace.tabs-search-trash-restore";
  await s.run("overflow-search", "interaction", async () => {
    await s.page.getByRole("button", { name: /^Tabs and Trashcan,/ }).click();
    await s.page.getByLabel("Search tabs", { exact: true }).fill("Performance text");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    await s.page
      .getByRole("tab", { name: "Performance text", selected: true, exact: true })
      .waitFor();
  });
  const tabId = (await s.page
    .getByRole("tab", { name: "Performance text", exact: true })
    .getAttribute("id"))!.slice(4);
  await s.run("trash-and-restore", "interaction", async () => {
    await s.page.getByRole("tab", { name: "Performance text", exact: true }).focus();
    await s.page.keyboard.press("ControlOrMeta+w");
    await until(
      () =>
        s.page.evaluate(
          (id) =>
            window.scope
              .retainedTabs()
              .then((tabs) =>
                tabs.some((entry) => entry.tab.id === id && entry.trashedAt !== null),
              ),
          tabId,
        ),
      Boolean,
    );
    await s.page.evaluate((id) => window.scope.restoreTab(id), tabId);
    await s.open("Performance text");
    await s.page.getByRole("tabpanel", { name: "Performance text" }).locator("pre").waitFor();
  });
  s.status(
    s.feature,
    "measured",
    "Overflow picker, search, keyboard close and real restore IPC followed by visible content",
  );
  if (
    (s.phase === "baseline" && !s.coverage.get("workspace.groups")?.samples) ||
    s.phase === "repeat-cleanup-restart"
  )
    await groups(s);
}
async function groups(s: Session) {
  s.feature = "workspace.groups";
  await s.open("Performance text");
  const visibleId = (await s.page
    .getByRole("tab", { name: "Performance text", selected: true, exact: true })
    .getAttribute("id"))!.slice(4);
  const baseline = (await until(
    () => s.page.evaluate(() => window.scope.workspace()),
    (workspace) => workspace?.selected === visibleId,
  ))!;
  const tab = baseline.tabs.find((tab) => tab.title === "Performance text")!;
  const groupId = crypto.randomUUID();
  try {
    await s.run("move-group-reload-visible", "integration", async () => {
      await s.page.evaluate(
        async ({ groupId, tabId }) => {
          const workspace = (await window.scope.workspace())!;
          await window.scope.saveWorkspace({
            ...workspace,
            groups: [
              ...workspace.groups,
              { id: groupId, owner: { kind: "performance", id: groupId } },
            ],
            tabs: workspace.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId } : tab)),
            selected: tabId,
          });
        },
        { groupId, tabId: tab.id },
      );
      await s.reloadRenderer();
      await s.page.getByRole("tabpanel", { name: "Performance text" }).locator("pre").waitFor();
      const saved = (await s.page.evaluate(() => window.scope.workspace()))!;
      check(
        saved.tabs.find((item) => item.id === tab.id)?.groupId === groupId &&
          saved.groups.some((group) => group.id === groupId),
        "Moved tab group was not persisted",
      );
    });
  } finally {
    await s.page.evaluate((value) => window.scope.saveWorkspace(value), baseline);
    await s.reloadRenderer();
    await s.page.getByRole("tabpanel", { name: "Performance text" }).locator("pre").waitFor();
  }
  s.report.event("renderer-reload", {
    phase: s.phase,
    reason:
      "Hydrate public group membership writes and restore baseline; excluded from the mixed long-lived segment",
  });
  s.status(
    s.feature,
    "measured",
    "Create a second group and move a real tab through public workspace IPC; reload verifies visible content and persisted membership, then restores baseline. Baseline/end only to preserve the mixed renderer session.",
  );
}

export async function scaleTabs(s: Session, count: number) {
  const client = await s.client();
  const existing = (await client.list()).filter((item) => item.id.startsWith("perf-scale-"));
  for (let i = existing.length; i < count; i++)
    await client.publish(
      `perf-scale-${i}`,
      {
        title: `Performance scale ${i}`,
        expectedRevision: 0,
        kind: "text",
        mediaType: "text/plain",
        fileName: "scale.txt",
      },
      new TextEncoder().encode(`Synthetic scale ${i}`),
    );
  for (const item of existing.slice(count)) await client.delete(item.id);
  await until(
    () => s.page.evaluate(() => window.scope.workspace()),
    (value) =>
      !!value &&
      value.tabs.filter((tab) => tab.title.startsWith("Performance scale")).length === count,
  );
  check(
    (await s.page.evaluate(() => window.scope.workspace()))!.tabs.length <= 200,
    "Open tab cap exceeded",
  );
  s.report.event("workload", { phase: s.phase, workload: s.workload, extraTabs: count });
}
export async function restart(s: Session) {
  s.feature = "workspace.restart";
  const before = await s.page.evaluate(() => window.scope.workspace());
  const prompt = await (await s.client()).prompts({ action: "read-workspace" });
  const inbox = await (await s.client()).pullRequests({ action: "read", name: "performance-pr" });
  const sketchpadId = before?.tabs.find((tab) => tab.type === "sketchpad")?.id;
  await s.run("close", "interaction", () => s.close());
  await s.launch();
  await s.run("restored-content", "interaction", async () => {
    const after = await s.page.evaluate(() => window.scope.workspace());
    check(after?.tabs.length === before?.tabs.length, "Restart changed open tab count");
    check(
      before?.tabs.every((tab) =>
        after?.tabs.some((item) => item.id === tab.id && item.groupId === tab.groupId),
      ),
      "Group missing after restart",
    );
    const restoredInbox = await (
      await s.client()
    ).pullRequests({ action: "read", name: "performance-pr" });
    check(
      inbox.type === "snapshot" &&
        restoredInbox.type === "snapshot" &&
        inbox.snapshot.prs[0]?.local.note === restoredInbox.snapshot.prs[0]?.local.note,
      "PR note changed after restart",
    );
    if (sketchpadId)
      check(
        (
          await s.page.evaluate((id) => window.scope.sketchpadDraft(id), sketchpadId)
        )?.content.includes("rectangle"),
        "Sketchpad drawing missing after restart",
      );
    const restoredPrompt = await (await s.client()).prompts({ action: "read-workspace" });
    check(
      JSON.stringify(prompt) === JSON.stringify(restoredPrompt),
      "Prompt workspace changed after restart",
    );
    await s.open("Performance text");
    await s.page.getByRole("tabpanel", { name: "Performance text" }).locator("pre").waitFor();
  });
  s.status(
    s.feature,
    "measured",
    "Equivalent tab count, group and current prompt survive graceful Electron restart",
  );
}
