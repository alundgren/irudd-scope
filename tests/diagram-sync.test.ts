import { test, expect } from "vite-plus/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyDiagramDelta,
  diagramDelta,
  type NativeDiagram,
} from "@irudd-scope/protocol/diagram-sync";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";

test("named native diagrams support session handoff, conflict reconciliation, editable proposals and deletion", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    const file = join(fixture.directory, "native.excalidraw");
    await writeFile(file, JSON.stringify(nativeDiagram()));
    const artifact = JSON.parse(
      (await fixture.cli("add", file, "--named", "--title", "Native gallery")).stdout,
    );
    expect(artifact.name).toMatch(/^native-gallery-[a-f0-9]{8}$/);
    expect(JSON.parse((await fixture.cli("get", artifact.name)).stdout).id).toBe(artifact.id);
    let client = await fixture.connect();
    await expect
      .poll(
        async () =>
          (await client.syncDiagram({ action: "status", name: artifact.name }).catch(() => null))
            ?.type,
        { timeout: 10_000 },
      )
      .toBe("status");
    await expect(fixture.cli("add", file, "--name", artifact.name)).rejects.toThrow("name");
    const working = join(fixture.directory, "agent.json");
    await fixture.cli("diagram", "pull", artifact.name, "--output", working);
    const initial = JSON.parse(await readFile(working, "utf8"));
    expect(
      new Set(initial.document.elements.map((element: { type: string }) => element.type)),
    ).toEqual(new Set(nativeDiagram().elements.map((element) => element.type)));
    expect(initial.base.files["sample-image"]).toMatch(/^[a-f0-9]{64}$/);
    const originalX = initial.document.elements[0].x;
    initial.document.elements[0].x = originalX + 12;
    await writeFile(working, JSON.stringify(initial));
    await fixture.cli("diagram", "push", working);
    const updated = JSON.parse(await readFile(working, "utf8"));
    expect(updated.version).not.toBe(initial.version);
    expect(updated.document.elements[0].x).toBe(originalX + 12);
    const remote = structuredClone(updated.document) as NativeDiagram;
    (remote.elements[0] as Record<string, unknown>).y = Number(remote.elements[0].y) + 8;
    const result = await client.syncDiagram({
      action: "write",
      name: artifact.name,
      expectedVersion: updated.version,
      delta: diagramDelta(updated.document, remote),
    });
    expect(result.type).toBe("applied");
    updated.document.elements[1].strokeColor = "#e03131";
    await writeFile(working, JSON.stringify(updated));
    await expect(fixture.cli("diagram", "push", working)).rejects.toMatchObject({ code: 2 });
    const merge = JSON.parse((await fixture.cli("diagram", "rebase", working)).stdout);
    expect(merge.conflicts).toEqual([]);
    await fixture.cli("diagram", "push", working);
    const merged = JSON.parse(await readFile(working, "utf8"));
    expect(merged.document.elements[0].y).toBe(remote.elements[0].y);
    expect(merged.document.elements[1].strokeColor).toBe("#e03131");
    expect(
      (
        await client.syncDiagram({
          action: "write",
          name: artifact.name,
          expectedVersion: initial.version,
          delta: diagramDelta(initial.document, merged.document),
        })
      ).type,
    ).toBe("conflict");
    merged.document.elements[2].backgroundColor = "#ffc9c9";
    await writeFile(working, JSON.stringify(merged));
    await fixture.cli("diagram", "propose", working, "--note", "Use a red decision?");
    await page.getByRole("region", { name: "Proposed diagram" }).waitFor();
    await page.getByText("Use a red decision?", { exact: false }).waitFor();
    const preview = page.getByRole("region", { name: "Proposed diagram" });
    const previewCanvas = preview.locator("canvas.interactive");
    await preview.getByTestId("toolbar-text").locator("..").click();
    const bounds = await previewCanvas.boundingBox();
    await page.mouse.click(bounds!.x + 400, bounds!.y + 350);
    await preview.locator("textarea.excalidraw-wysiwyg").fill("Human proposal note");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await expect.poll(() => page.getByRole("region", { name: "Proposed diagram" }).count()).toBe(0);
    const accepted = await client.syncDiagram({ action: "read", name: artifact.name });
    expect(accepted.type).toBe("full");
    if (accepted.type !== "full") throw new Error("Expected full document");
    expect(accepted.document.elements[2].backgroundColor).toBe("#ffc9c9");
    expect(
      accepted.document.elements.some((element) => element.text === "Human proposal note"),
    ).toBe(true);
    await fixture.cli("diagram", "rebase", working);
    const candidate = JSON.parse(await readFile(working, "utf8"));
    candidate.document.elements[1].opacity = 70;
    await writeFile(working, JSON.stringify(candidate));
    await fixture.cli("diagram", "propose", working, "--note", "Try a lighter object?");
    await client.syncDiagram({
      action: "write",
      name: artifact.name,
      expectedVersion: candidate.version,
      delta: {
        elements: [{ id: String(candidate.document.elements[0].id), set: { x: 99 } }],
        deleted: [],
        files: {},
      },
    });
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await page.getByText("The original diagram changed.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Reject proposal" }).click();
    await expect.poll(() => preview.count()).toBe(0);
    await fixture.cli("diagram", "rebase", working);
    await fixture.cli("diagram", "propose", working, "--note", "Persist this proposal");
    // Reopening loses bounded in-memory history; a stale session recovers using a full pull.
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    client = await fixture.connect();
    await page.getByRole("tab", { name: "Native gallery", exact: false }).click();
    await expect
      .poll(
        async () =>
          (await client.syncDiagram({ action: "status", name: artifact.name }).catch(() => null))
            ?.type,
        { timeout: 10_000 },
      )
      .toBe("status");
    await page.getByText("Persist this proposal", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await expect.poll(() => page.getByRole("region", { name: "Proposed diagram" }).count()).toBe(0);
    const fallback = await client.syncDiagram({
      action: "read",
      name: artifact.name,
      since: initial.version,
    });
    expect(fallback.type).toBe("full");
    const handoff = join(fixture.directory, "next-session.json");
    await fixture.cli("diagram", "pull", artifact.name, "--output", handoff);
    const handoffModel = JSON.parse(await readFile(handoff, "utf8"));
    const front = {
      ...handoffModel.document.elements.find(
        (element: { type: string }) => element.type === "rectangle",
      ),
      id: "remote-front",
      boundElements: [],
      groupIds: [],
      frameId: null,
    };
    const middle = { ...front, id: "remote-middle" };
    const next = {
      ...handoffModel.document,
      elements: [
        front,
        handoffModel.document.elements[0],
        middle,
        ...handoffModel.document.elements.slice(1),
      ],
    };
    await client.syncDiagram({
      action: "write",
      name: artifact.name,
      expectedVersion: handoffModel.version,
      delta: diagramDelta(handoffModel.document, next),
    });
    handoffModel.document.elements[0].opacity = 55;
    await writeFile(handoff, JSON.stringify(handoffModel));
    expect(JSON.parse((await fixture.cli("diagram", "rebase", handoff)).stdout).conflicts).toEqual(
      [],
    );
    const rebased = JSON.parse(await readFile(handoff, "utf8"));
    expect(
      rebased.document.elements.slice(0, 3).map((element: { id: string }) => element.id),
    ).toEqual(["remote-front", handoffModel.document.elements[0].id, "remote-middle"]);
    expect(rebased.document.elements[1].opacity).toBe(55);
    await fixture.cli("diagram", "push", handoff);
    await client.delete(artifact.id);
    await expect(client.named(artifact.name)).rejects.toMatchObject({ status: 404 });
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60_000);

test("deltas retain assets, object deletion, order, and native properties", () => {
  const before = nativeDiagram();
  const after = structuredClone(before);
  const moved = after.elements[2] as Record<string, unknown>;
  moved.x = 42;
  delete moved.customData;
  const result = { ...after, elements: after.elements.slice(1).reverse() };
  const delta = diagramDelta(before, result);
  expect(delta.files).toEqual({});
  expect(delta.deleted).toEqual(["object-0"]);
  expect(applyDiagramDelta(before, delta)).toEqual(result);
  expect(() =>
    applyDiagramDelta(before, {
      ...delta,
      order: [...result.elements.map((element) => String(element.id)), "object-1"],
    }),
  ).toThrow("exactly once");
});

test("agent writes wait for human drawing gestures and text edits to finish", async () => {
  const fixture = await desktopFixture();
  const application = await fixture.launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    const client = await fixture.connect();
    const name = "active-human-edit";
    await client.publish(
      name,
      {
        name,
        title: "Active human edit",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "active.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(nativeDiagram(1))),
    );
    const canvas = page.locator(".diagram-original canvas.interactive");
    await canvas.click({ position: { x: 500, y: 180 } });
    await page.keyboard.press("r");
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + 400, bounds.y + 200);
    await page.mouse.down();
    const during = await client.syncDiagram({ action: "read", name });
    expect(during.type).toBe("full");
    await expect(
      client.syncDiagram({
        action: "write",
        name,
        expectedVersion: during.version,
        delta: { elements: [{ id: "object-0", set: { opacity: 70 } }], deleted: [], files: {} },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await page.mouse.move(bounds.x + 520, bounds.y + 260, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.mouse.click(bounds.x + 400, bounds.y + 350);
    await page.locator("textarea.excalidraw-wysiwyg").fill("Still typing");
    const typing = await client.syncDiagram({ action: "read", name });
    await expect(
      client.syncDiagram({
        action: "write",
        name,
        expectedVersion: typing.version,
        delta: { elements: [{ id: "object-0", set: { opacity: 70 } }], deleted: [], files: {} },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await page.locator("textarea.excalidraw-wysiwyg").fill("Finished typing");
    await page.keyboard.press("Escape");
    const committed = await client.syncDiagram({ action: "read", name });
    expect(
      (
        await client.syncDiagram({
          action: "write",
          name,
          expectedVersion: committed.version,
          delta: { elements: [{ id: "object-0", set: { opacity: 70 } }], deleted: [], files: {} },
        })
      ).type,
    ).toBe("applied");
    const final = await client.syncDiagram({ action: "read", name });
    if (final.type !== "full") throw new Error("Expected full diagram");
    expect(final.document.elements.filter((element) => element.type === "rectangle")).toHaveLength(
      2,
    );
    expect(final.document.elements.find((element) => element.type === "text")?.text).toBe(
      "Finished typing",
    );
  } finally {
    await application.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);
