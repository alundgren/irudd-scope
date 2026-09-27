import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { emptyScene, type SceneNode, type SemanticScene } from "./contract.ts";
import { sceneObjects } from "./scene.ts";

type ElementInput = NonNullable<Parameters<typeof convertToExcalidrawElements>[0]>[number];
type Category = keyof SemanticScene;
type AgentData = {
  category: Category;
  object: ReturnType<typeof sceneObjects>[number];
  primary: boolean;
};

const elementId = (id: string) => `agent:${id}`;
const labelId = (id: string) => `agent:${id}:label`;
const nativeGroupId = (id: string) => `agent-group:${id}`;
const defaults = {
  strokeColor: "#334155",
  backgroundColor: "#f1f5f9",
  fillStyle: "solid",
  strokeWidth: 1.5,
  roughness: 0,
  roundness: { type: 3 },
} as const;
const labelDefaults = { fontSize: 20, fontFamily: 2 } as const;
const data = (category: Category, object: AgentData["object"], primary = true) => ({
  drawingAgent: { category, object, primary },
});

function agentData(element: ExcalidrawElement): AgentData | undefined {
  return element.customData?.drawingAgent as AgentData | undefined;
}

function boundary(node: SceneNode, target: SceneNode): [number, number] {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = target.x + target.width / 2 - cx;
  const dy = target.y + target.height / 2 - cy;
  if (!dx && !dy) return [cx + node.width / 2 + 6, cy];
  const nx = Math.abs(dx) / (node.width / 2);
  const ny = Math.abs(dy) / (node.height / 2);
  const divisor =
    node.kind === "ellipse"
      ? Math.hypot(nx, ny)
      : node.kind === "diamond"
        ? nx + ny
        : Math.max(nx, ny);
  const length = Math.hypot(dx, dy);
  return [cx + dx / divisor + (dx / length) * 6, cy + dy / divisor + (dy / length) * 6];
}

export function renderScene(scene: SemanticScene): ExcalidrawElement[] {
  const groupIds = (id: string) =>
    scene.groups.filter((group) => group.ids.includes(id)).map((group) => nativeGroupId(group.id));
  const items: ElementInput[] = [];
  for (const node of scene.nodes) {
    const label = {
      ...labelDefaults,
      id: labelId(node.id),
      text: node.label,
      groupIds: groupIds(node.id),
      customData: data("nodes", node, false),
    };
    items.push({
      ...defaults,
      type: node.kind,
      id: elementId(node.id),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      groupIds: groupIds(node.id),
      customData: data("nodes", node),
      label,
    });
  }
  for (const text of scene.texts) {
    items.push({
      type: "text",
      id: elementId(text.id),
      text: text.text,
      x: text.x,
      y: text.y,
      ...labelDefaults,
      strokeColor: defaults.strokeColor,
      groupIds: groupIds(text.id),
      customData: data("texts", text),
    });
  }
  // Native text wrapping can enlarge a node. Measure it before placing borders and arrows.
  const measured = new Map(
    convertToExcalidrawElements(items, { regenerateIds: false }).map((item) => [item.id, item]),
  );
  const nodes = scene.nodes.map((node) => {
    const element = measured.get(elementId(node.id))!;
    return { ...node, width: element.width, height: element.height };
  });
  const nodeIds = new Set(nodes.map((node) => elementId(node.id)));
  const finalItems: ElementInput[] = [];
  for (const group of scene.groups) {
    const members = group.ids.map((id) => measured.get(elementId(id))!);
    const x = Math.min(...members.map((item) => item.x)) - 24;
    const y = Math.min(...members.map((item) => item.y)) - 48;
    const title: ElementInput = {
      type: "text",
      id: labelId(group.id),
      text: group.label,
      x: x + 16,
      y: y + 12,
      ...labelDefaults,
      fontSize: 16,
      strokeColor: defaults.strokeColor,
      groupIds: [nativeGroupId(group.id)],
      customData: data("groups", group, false),
    };
    const titleWidth = convertToExcalidrawElements([title], { regenerateIds: false })[0].width;
    finalItems.push(
      {
        ...defaults,
        type: "rectangle",
        id: elementId(group.id),
        x,
        y,
        width: Math.max(
          Math.max(...members.map((item) => item.x + item.width)) - x + 24,
          titleWidth + 32,
        ),
        height: Math.max(...members.map((item) => item.y + item.height)) - y + 24,
        strokeStyle: "dashed",
        backgroundColor: "transparent",
        groupIds: [nativeGroupId(group.id)],
        customData: data("groups", group),
      },
      title,
    );
  }
  finalItems.push(
    ...items.map((item) =>
      nodeIds.has(item.id!)
        ? { ...item, width: measured.get(item.id!)!.width, height: measured.get(item.id!)!.height }
        : item,
    ),
  );
  for (const connection of scene.connections) {
    const from = nodes.find((node) => node.id === connection.from)!;
    const to = nodes.find((node) => node.id === connection.to)!;
    let start = boundary(from, to);
    let end = boundary(to, from);
    let points: [number, number][] = [
      [0, 0],
      [end[0] - start[0], end[1] - start[1]],
    ];
    const hasReturn = scene.connections.some((edge) => edge.from === to.id && edge.to === from.id);
    // Separate a return path from the forward arrow so both directions and labels remain visible.
    if (hasReturn && (to.x < from.x || (to.x === from.x && to.y < from.y))) {
      if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)) {
        start = [from.x + from.width / 2, from.y + from.height + 6];
        end = [to.x + to.width / 2, to.y + to.height + 6];
        const lane = Math.max(start[1], end[1]) + 64;
        points = [
          [0, 0],
          [0, lane - start[1]],
          [end[0] - start[0], lane - start[1]],
          [end[0] - start[0], end[1] - start[1]],
        ];
      } else {
        start = [from.x + from.width + 6, from.y + from.height / 2];
        end = [to.x + to.width + 6, to.y + to.height / 2];
        const lane = Math.max(start[0], end[0]) + 64;
        points = [
          [0, 0],
          [lane - start[0], 0],
          [lane - start[0], end[1] - start[1]],
          [end[0] - start[0], end[1] - start[1]],
        ];
      }
    }
    const groups = groupIds(from.id).filter((id) => groupIds(to.id).includes(id));
    const label = {
      ...labelDefaults,
      fontSize: 16,
      id: labelId(connection.id),
      text: connection.label,
      groupIds: groups,
      customData: data("connections", connection, false),
    };
    finalItems.push({
      ...defaults,
      type: "arrow",
      id: elementId(connection.id),
      x: start[0],
      y: start[1],
      points,
      start: { id: elementId(from.id) },
      end: { id: elementId(to.id) },
      startArrowhead: null,
      endArrowhead: "arrow",
      strokeStyle: connection.style,
      groupIds: groups,
      customData: data("connections", connection),
      label,
    });
  }
  return convertToExcalidrawElements(finalItems, { regenerateIds: false });
}

export function updateCanvasElements(
  before: SemanticScene,
  after: SemanticScene,
  current: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  const previous = new Map(sceneObjects(before).map((item) => [item.id, item]));
  const changed = new Set(
    sceneObjects(after)
      .filter((item) => JSON.stringify(previous.get(item.id)) !== JSON.stringify(item))
      .map((item) => item.id),
  );
  for (const item of sceneObjects(before)) {
    if (!sceneObjects(after).some((next) => next.id === item.id)) changed.add(item.id);
  }
  for (const group of [...before.groups, ...after.groups]) {
    if (changed.has(group.id) || group.ids.some((id) => changed.has(id))) {
      changed.add(group.id);
      group.ids.forEach((id) => changed.add(id));
    }
  }
  for (const edge of [...before.connections, ...after.connections]) {
    if (changed.has(edge.from) || changed.has(edge.to) || changed.has(edge.id)) {
      changed.add(edge.id);
      // Node bindings must include newly added and removed connections.
      changed.add(edge.from);
      changed.add(edge.to);
    }
  }
  const existing = new Map(current.map((item) => [item.id, item]));
  const rendered = renderScene(after).map((item) => {
    const old = existing.get(item.id);
    if (!old) return item;
    if (!old.isDeleted && !changed.has(agentData(item)!.object.id)) return old;
    const {
      id: _id,
      version: _version,
      versionNonce: _nonce,
      updated: _updated,
      ...properties
    } = item;
    return newElementWith(old, {
      ...properties,
      seed: old.seed,
      strokeColor: old.strokeColor,
      backgroundColor: old.backgroundColor,
      fillStyle: old.fillStyle,
      roughness: old.roughness,
    });
  });
  const active = new Set(rendered.map((item) => item.id));
  const retained = current
    .filter((item) => !active.has(item.id))
    .map((item) =>
      agentData(item) && !item.isDeleted ? newElementWith(item, { isDeleted: true }) : item,
    );
  return [...rendered, ...retained];
}

export function readSemanticScene(elements: readonly ExcalidrawElement[]): SemanticScene {
  const scene = emptyScene();
  const active = elements.filter((item) => !item.isDeleted);
  const byId = new Map(active.map((item) => [item.id, item]));
  for (const element of active) {
    const meta = agentData(element);
    // Excalidraw duplicates customData when copying. Only the original ID owns the semantic object.
    if (!meta?.primary || element.id !== elementId(meta.object.id)) continue;
    const boundLabel = active.find(
      (item) => item.type === "text" && item.containerId === element.id,
    );
    const title = byId.get(labelId(meta.object.id));
    const label = boundLabel?.type === "text" ? boundLabel.originalText : "";
    if (meta.category === "nodes" && ["rectangle", "ellipse", "diamond"].includes(element.type)) {
      scene.nodes.push({
        id: meta.object.id,
        kind: element.type as SceneNode["kind"],
        label,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      });
    } else if (meta.category === "texts" && element.type === "text") {
      scene.texts.push({
        id: meta.object.id,
        text: element.originalText,
        x: element.x,
        y: element.y,
      });
    } else if (
      meta.category === "connections" &&
      element.type === "arrow" &&
      "from" in meta.object
    ) {
      const start = element.startBinding && byId.get(element.startBinding.elementId);
      const end = element.endBinding && byId.get(element.endBinding.elementId);
      scene.connections.push({
        ...meta.object,
        label,
        style: element.strokeStyle === "dashed" ? "dashed" : "solid",
        from: (start && agentData(start)?.object.id) || meta.object.from,
        to: (end && agentData(end)?.object.id) || meta.object.to,
      });
    } else if (meta.category === "groups" && "ids" in meta.object) {
      scene.groups.push({
        ...meta.object,
        label: title?.type === "text" ? title.originalText : meta.object.label,
      });
    }
  }
  const nodes = new Set(scene.nodes.map((item) => item.id));
  const members = new Set([...nodes, ...scene.texts.map((item) => item.id)]);
  scene.connections = scene.connections.filter(
    (item) => nodes.has(item.from) && nodes.has(item.to),
  );
  scene.groups = scene.groups
    .map((item) => ({ ...item, ids: item.ids.filter((id) => members.has(id)) }))
    .filter((item) => item.ids.length);
  return scene;
}
