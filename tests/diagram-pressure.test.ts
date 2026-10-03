import { expect, test } from "vite-plus/test";
import type { Page } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ScopeError } from "@irudd-scope/protocol";
import type { ScopeClient } from "@irudd-scope/protocol/client";
import {
  applyDiagramDelta,
  diagramDelta,
  parseNativeDiagram,
  type DiagramSyncCommand,
  type NativeDiagram,
} from "@irudd-scope/protocol/diagram-sync";
import { desktopFixture } from "./desktop-fixture.ts";
import { nativeDiagram } from "./fixtures/native-diagram.ts";
import { contentCounts } from "./pressure-fixture.ts";

const name = "concurrent-diagram";
const setting = (key: string, fallback: number, maximum: number) => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${key} must be an integer between 1 and ${maximum}.`);
  return value;
};
const edits = setting("SCOPE_DIAGRAM_PRESSURE_EDITS", 40, 2000);
const humanEdits = setting("SCOPE_DIAGRAM_PRESSURE_HUMAN", 8, 200);
const seed = setting("SCOPE_DIAGRAM_PRESSURE_SEED", 7294, 2 ** 31 - 1);
type Model = { document: NativeDiagram; version: string };
type Stats = { applied: number; conflicts: number; busy: number; fullReads: number };
const stats = (): Stats => ({ applied: 0, conflicts: 0, busy: 0, fullReads: 0 });

async function command(client: ScopeClient, input: DiagramSyncCommand, counters: Stats) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await client.syncDiagram(input);
    } catch (error) {
      if (!(error instanceof ScopeError) || error.status !== 409 || Date.now() > deadline)
        throw error;
      counters.busy++;
      await delay(2 + ((counters.busy * 7 + seed) % 23));
    }
  }
}

async function read(client: ScopeClient, counters: Stats, previous?: Model): Promise<Model> {
  const result = await command(
    client,
    { action: "read", name, ...(previous ? { since: previous.version } : {}) },
    counters,
  );
  if (result.type === "full") {
    counters.fullReads++;
    return result;
  }
  if (result.type === "delta" && previous)
    return {
      document: applyDiagramDelta(previous.document, result.delta),
      version: result.version,
    };
  throw new Error(`Unexpected read result: ${result.type}`);
}

function mutate(document: NativeDiagram, agent: number, step: number): NativeDiagram {
  let elements = document.elements.map((element) => ({ ...element }));
  const counter = elements.find((element) => element.id === "object-0")!;
  const data = (counter.customData ?? {}) as Record<string, unknown>;
  counter.customData = { ...data, pressureTotal: Number(data.pressureTotal ?? 0) + 1 };
  elements.find((element) => element.id === `agent-${agent}`)!.customData = { step: step + 1 };
  const target = elements.find(
    (element) => element.id === `object-${24 + ((step * 13 + agent * 17 + seed) % 216)}`,
  )!;
  target.x = Number(target.x) + 2;
  target.opacity = 60 + (step % 40);
  if (target.type === "text") {
    target.text = `Agent ${agent}, edit ${step}`;
    target.originalText = target.text;
  }
  if (["line", "arrow", "freedraw"].includes(String(target.type)) && !target.elbowed)
    target.points = [
      [0, 0],
      [70 + (step % 20), 25],
      [160, 100],
    ];
  const added = (id: string) => ({
    ...counter,
    id,
    x: 3000 + agent * 200,
    y: 3000 + step * 20,
    boundElements: null,
    groupIds: [],
    frameId: null,
    customData: { agent, step },
  });
  if (step % 20 === 0) elements.push(added(`kept-${agent}-${step}`));
  if (step % 7 === 0) elements.push(added(`temporary-${agent}`));
  if (step % 7 === 2) elements = elements.filter((element) => element.id !== `temporary-${agent}`);
  if (step % 19 === 0) elements.reverse();
  return { ...document, elements };
}

async function edit(
  client: ScopeClient,
  initial: Model,
  agent: number,
  step: number,
  counters: Stats,
): Promise<Model> {
  let model = initial;
  let deadline = Date.now() + 30_000;
  for (;;) {
    const document = mutate(model.document, agent, step);
    const result = await command(
      client,
      agent === 3
        ? { action: "replace", name, expectedVersion: model.version, document }
        : {
            action: "write",
            name,
            expectedVersion: model.version,
            delta: diagramDelta(model.document, document),
          },
      counters,
    );
    if (result.type === "applied") {
      counters.applied++;
      return {
        version: result.version,
        document: applyDiagramDelta(document, result.delta),
      };
    }
    if (result.type !== "conflict") throw new Error(`Unexpected write result: ${result.type}`);
    counters.conflicts++;
    if (result.version !== model.version) deadline = Date.now() + 30_000;
    else if (Date.now() > deadline)
      throw new Error("Competing writers made no version progress for 30 seconds.");
    model = result.delta
      ? { version: result.version, document: applyDiagramDelta(model.document, result.delta) }
      : await read(client, counters, model);
    await delay(2 + ((counters.conflicts * 7 + agent * 11 + seed) % 23));
  }
}

async function prepareHuman(page: Page) {
  const editor = page.locator(".diagram-original");
  await editor.getByRole("button", { name: "Reset zoom", exact: true }).click();
  const canvas = editor.locator("canvas.interactive");
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 500, bounds.y + 180);
  await page.mouse.wheel(0, 30_000);
  await canvas.click({ position: { x: 500, y: 180 } });
}

async function human(page: Page, count: number, progress: () => number) {
  const canvas = page.locator(".diagram-original canvas.interactive");
  const tools = ["r", "o", "d", "a", "l", "p"];
  const overlap = { start: progress(), end: 0 };
  for (let index = 0; index < count; index++) {
    const bounds = (await canvas.boundingBox())!;
    await page.keyboard.press("Escape");
    await page.keyboard.press(tools[index % tools.length]);
    await page.mouse.move(bounds.x + 420, bounds.y + 180);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 540, bounds.y + 240, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.mouse.click(bounds.x + 420, bounds.y + 330);
    await page.locator("textarea.excalidraw-wysiwyg").pressSequentially(`Human ${index}`, {
      delay: 4,
    });
    await page.keyboard.press("Escape");
    await page.mouse.wheel(0, 400);
  }
  overlap.end = progress();
  return overlap;
}

function verify(document: NativeDiagram, count: number, expectedEdits: number) {
  parseNativeDiagram(document);
  const counter = document.elements.find((element) => element.id === "object-0")!;
  expect((counter.customData as { pressureTotal: number }).pressureTotal).toBe(expectedEdits);
  for (let agent = 0; agent < 4; agent++) {
    expect(
      document.elements.find((element) => element.id === `agent-${agent}`)!.customData,
    ).toEqual({ step: edits });
    for (let step = 0; step < edits; step += 20)
      expect(document.elements.some((element) => element.id === `kept-${agent}-${step}`)).toBe(
        true,
      );
    expect(document.elements.some((element) => element.id === `temporary-${agent}`)).toBe(
      (edits - 1) % 7 < 2,
    );
  }
  const humanElements = document.elements.filter(
    (element) => !/^(object-|agent-|kept-|temporary-)/.test(String(element.id)),
  );
  expect(humanElements.filter((element) => element.type !== "text")).toHaveLength(count);
  expect(
    humanElements
      .filter((element) => element.type === "text")
      .map((element) => String(element.text))
      .sort(),
  ).toEqual(Array.from({ length: count }, (_, index) => `Human ${index}`).sort());
  expect(
    new Set(
      document.elements
        .filter((element) => String(element.id).startsWith("object-"))
        .map((element) => element.type),
    ),
  ).toEqual(new Set(nativeDiagram().elements.map((element) => element.type)));
  expect(Object.keys(document.files)).toContain("sample-image");
}

test("human drawing and competing agent deltas preserve edits, reject stale proposals and clean up after deletion", async () => {
  const fixture = await desktopFixture();
  let application = await fixture.launch();
  let stop = false;
  let pending: Promise<PromiseSettledResult<void>[]> | undefined;
  const agents = Array.from({ length: 4 }, stats);
  const other = stats();
  const errors: string[] = [];
  const started = performance.now();
  const report: Record<string, unknown> = { seed, editsPerAgent: edits, humanEdits, agents };
  try {
    let page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    let client = await fixture.connect();
    const source = nativeDiagram(240, 128 * 1024);
    const document = {
      ...source,
      elements: [
        ...source.elements,
        ...agents.map((_, index) => ({
          ...source.elements[0],
          id: `agent-${index}`,
          boundElements: null,
          groupIds: [],
          frameId: null,
          customData: { step: 0 },
        })),
      ],
    };
    await client.publish(
      name,
      {
        name,
        title: "Concurrent diagram",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "pressure.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(document)),
    );
    const initial = await read(client, other);
    await prepareHuman(page);
    pending = Promise.allSettled(
      agents.map(async (counters, agent) => {
        let model = initial;
        for (let step = 0; step < edits && !stop; step++) {
          model = await edit(client, model, agent, step, counters);
          await delay((agent + step + seed) % 7);
        }
      }),
    );
    const overlap = await human(page, humanEdits, () =>
      agents.reduce((sum, value) => sum + value.applied, 0),
    );
    report.agentWritesDuringHumanLoop = overlap;
    expect(overlap.end).toBeGreaterThan(overlap.start);
    const results = await pending;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    report.editElapsedMs = Math.round(performance.now() - started);
    expect(agents.map((value) => value.applied)).toEqual([edits, edits, edits, edits]);
    expect(agents.reduce((sum, value) => sum + value.conflicts, 0)).toBeGreaterThan(0);
    let latest = await read(client, other);
    report.humanObjects = latest.document.elements
      .filter((element) => !/^(object-|agent-|kept-|temporary-)/.test(String(element.id)))
      .map((element) => ({
        type: element.type,
        ...(element.type === "text" ? { text: element.text } : {}),
      }));
    verify(latest.document, humanEdits, edits * 4);
    if (edits * 4 > 128)
      expect(
        (await command(client, { action: "read", name, since: initial.version }, other)).type,
      ).toBe("full");

    // A visual decision must not overwrite a writer that moved ahead during discussion.
    await command(
      client,
      {
        action: "propose",
        name,
        expectedVersion: latest.version,
        delta: {
          elements: [],
          deleted: [],
          files: {},
          appState: { set: { viewBackgroundColor: "#ffc9c9" } },
        },
        note: "Pressure-test proposal",
      },
      other,
    );
    latest = await edit(client, latest, 0, edits, other);
    await page.getByRole("button", { name: "Accept proposal" }).click();
    await page.getByText("The original diagram changed.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Reject proposal" }).click();
    expect((await read(client, other)).document.appState.viewBackgroundColor).not.toBe("#ffc9c9");
    const beforeRestart = await read(client, other);
    await application.close();
    application = await fixture.launch();
    page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    client = await fixture.connect();
    await page.getByRole("tab", { name: "Concurrent diagram", exact: false }).click();
    latest = await read(client, other);
    expect(latest.document).toEqual(beforeRestart.document);
    report.restartPreservedDocument = true;
    report.storageBeforeClose = contentCounts(fixture.settingsDirectory);

    // Delete while writers are still arriving, then reuse the name with a new tab identity.
    const inFlight = Promise.allSettled(
      agents.map((_, index) => edit(client, latest, index, edits + 1, stats())),
    );
    await client.delete(name);
    const deletedResults = await inFlight;
    for (const result of deletedResults) {
      if (result.status === "fulfilled") continue;
      expect(result.reason).toBeInstanceOf(ScopeError);
      expect([404, 409, 503]).toContain(result.reason.status);
    }
    await expect(client.named(name)).rejects.toMatchObject({ status: 404 });
    const storage = contentCounts(fixture.settingsDirectory);
    expect(storage.integrity).toBe("ok");
    expect(storage.foreignKeys).toEqual([]);
    for (const table of ["artifacts", "blobs", "tab_drafts", "tab_blobs"])
      expect(storage.rows[table]).toBe(0);
    report.storageAfterClose = storage;
    await client.publish(
      "replacement-diagram",
      {
        name,
        title: "Replacement",
        kind: "excalidraw",
        mediaType: "application/vnd.excalidraw+json",
        fileName: "replacement.excalidraw",
        expectedRevision: 0,
      },
      Buffer.from(JSON.stringify(source)),
    );
    const stale = await command(
      client,
      { action: "replace", name, expectedVersion: latest.version, document: latest.document },
      other,
    );
    expect(stale.type).toBe("conflict");
    expect((await read(client, other)).document.elements).toHaveLength(240);
    await client.delete("replacement-diagram");
    expect(errors).toEqual([]);
    report.passed = true;
  } finally {
    stop = true;
    await pending;
    report.elapsedMs = Math.round(performance.now() - started);
    report.rendererErrors = errors;
    try {
      if (process.env.SCOPE_DIAGRAM_PRESSURE_OUTPUT)
        await writeFile(process.env.SCOPE_DIAGRAM_PRESSURE_OUTPUT, JSON.stringify(report, null, 2));
    } finally {
      try {
        await application.close();
      } finally {
        await rm(fixture.directory, { recursive: true, force: true });
      }
    }
  }
}, 600_000);
