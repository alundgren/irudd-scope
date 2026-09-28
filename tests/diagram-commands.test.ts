import { expect, test } from "vite-plus/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiagramSnapshot } from "@irudd-scope/protocol/diagram";
import { desktopFixture } from "./desktop-fixture.ts";

test("diagram commands create, read imported objects, reject stale edits and export the saved diagram", async () => {
  const { directory, launch, connect, cli } = await desktopFixture();
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.getByRole("button", { name: "Search and controls" }).waitFor();
    const operations = JSON.parse(
      await readFile(new URL("./fixtures/diagram-response.json", import.meta.url), "utf8"),
    ).operations;
    const file = join(directory, "operations.json");
    await writeFile(file, JSON.stringify(operations));
    expect(JSON.parse((await cli("diagram", "guide")).stdout).operations).toBeDefined();
    const receipt = JSON.parse(
      (await cli("diagram", "create", file, "--id", "created", "--title", "Created diagram"))
        .stdout,
    );
    expect(receipt).toMatchObject({
      type: "created",
      artifact: { id: "created", revision: 1, kind: "excalidraw" },
    });
    let client = await connect();
    async function read(id: string): Promise<DiagramSnapshot> {
      const result = await client.diagram({ action: "read", id });
      if (result.type !== "snapshot") throw new Error("Expected a snapshot.");
      return result.diagram;
    }
    await expect
      .poll(async () => (await read("created").catch(() => null))?.scene.nodes.length)
      .toBe(2);
    const generated = await read("created");
    const replacement = await client.diagram({
      action: "apply",
      id: "created",
      snapshot: generated.snapshot,
      operations: [
        { type: "delete", ids: ["browser"] },
        {
          type: "createNode",
          id: "browser",
          kind: "ellipse",
          label: "Browser",
          x: 100,
          y: 100,
          width: null,
          height: null,
        },
      ],
    });
    if (replacement.type !== "snapshot") throw new Error("Expected a snapshot.");
    expect(replacement.diagram.scene.nodes.find((node) => node.id === "browser")?.kind).toBe(
      "ellipse",
    );
    const native = JSON.parse(new TextDecoder().decode(await client.content("created")));
    for (const element of native.elements) {
      delete element.customData;
      if (element.id === "agent:browser") {
        element.strokeColor = "#e03131";
        element.backgroundColor = "#fff5f5";
        element.roughness = 2;
      }
    }
    native.elements.push({
      ...native.elements.find((element: { id: string }) => element.id === "agent:api"),
      id: "rotated-native",
      x: 800,
      angle: 0.4,
      boundElements: [],
    });
    native.elements.push({
      ...native.elements.at(-1),
      id: "agent:reserved",
      x: 1000,
      customData: {
        drawingAgent: {
          category: "nodes",
          primary: true,
          object: {
            id: "reserved",
            kind: "rectangle",
            label: "Reserved",
            x: 1000,
            y: 100,
            width: 180,
            height: 80,
          },
        },
      },
    });
    const imported = join(directory, "imported.excalidraw");
    await writeFile(imported, JSON.stringify(native));
    await cli("add", imported, "--id", "imported", "--title", "Imported diagram");
    await expect
      .poll(async () => (await read("imported").catch(() => null))?.scene.nodes.length)
      .toBe(2);
    const initial = await read("imported");
    expect(initial.scene.nodes.map((item) => item.id)).toContain("native:agent:browser");
    expect(initial.readOnly).toMatchObject([{ id: "native:rotated-native" }, { id: "reserved" }]);
    await expect(
      client.diagram({
        action: "apply",
        id: "imported",
        snapshot: initial.snapshot,
        operations: [
          {
            type: "group",
            id: "native:rotated-native",
            label: "Invalid",
            ids: ["native:agent:browser"],
          },
        ],
      }),
    ).rejects.toThrow("New diagram IDs");
    await expect(
      client.diagram({
        action: "apply",
        id: "imported",
        snapshot: initial.snapshot,
        operations: [
          {
            type: "createNode",
            id: "reserved",
            kind: "rectangle",
            label: "Invalid",
            x: 0,
            y: 0,
            width: null,
            height: null,
          },
        ],
      }),
    ).rejects.toThrow("Native element ID agent:reserved already exists");
    expect((await read("imported")).snapshot).toBe(initial.snapshot);
    await writeFile(
      file,
      JSON.stringify([{ type: "setLabel", id: "native:agent:browser", label: "Web client" }]),
    );
    const edit = JSON.parse(
      (await cli("diagram", "apply", "imported", file, "--snapshot", initial.snapshot)).stdout,
    );
    expect(edit.diagram).toMatchObject({ dirty: false, revision: 2 });
    expect(edit.diagram.scene.nodes[0].label).toBe("Web client");
    await expect(
      cli("diagram", "apply", "imported", file, "--snapshot", initial.snapshot),
    ).rejects.toThrow("canvas changed");
    await expect(
      client.diagram({
        action: "apply",
        id: "imported",
        snapshot: edit.diagram.snapshot,
        operations: [
          { type: "move", id: "native:agent:browser", x: 99, y: 99 },
          { type: "delete", ids: ["missing"] },
        ],
      }),
    ).rejects.toThrow("Unknown object");
    expect((await read("imported")).snapshot).toBe(edit.diagram.snapshot);
    expect((await client.get("imported")).revision).toBe(2);
    const png = join(directory, "preview.png");
    await cli(
      "diagram",
      "preview",
      "imported",
      "--snapshot",
      edit.diagram.snapshot,
      "--output",
      png,
    );
    expect((await readFile(png)).subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    client = await connect();
    await page.getByRole("tab", { name: "Imported diagram", exact: false }).click();
    await expect
      .poll(async () => (await read("imported").catch(() => null))?.scene.nodes[0].label, {
        timeout: 10000,
      })
      .toBe("Web client");
    await expect.poll(async () => (await client.get("imported")).revision).toBe(2);
    const published = JSON.parse(new TextDecoder().decode(await client.content("imported")));
    expect(
      published.elements.find((item: { id: string }) => item.id === "agent:browser"),
    ).toMatchObject({ strokeColor: "#e03131", backgroundColor: "#fff5f5", roughness: 2 });
    expect(
      published.elements.find((item: { id: string }) => item.id === "rotated-native"),
    ).toMatchObject({ angle: 0.4, x: 800 });
    expect(
      published.elements.find((item: { id: string }) => item.id === "agent:browser:label"),
    ).toMatchObject({ originalText: "Web client" });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
