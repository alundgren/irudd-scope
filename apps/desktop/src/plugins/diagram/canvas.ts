import { convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { emptyScene, type SceneNode, type SemanticScene } from "./contract.ts";
import { sceneObjects } from "./scene.ts";
import type { DiagramContext } from "@irudd-scope/protocol/diagram";

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
  strokeColor: "#1b1b1f",
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
  const value = element.customData?.drawingAgent;
  if (
    !value ||
    typeof value !== "object" ||
    !value.object ||
    typeof value.object.id !== "string" ||
    value.object.id.length === 0 ||
    value.object.id.length > 512 ||
    !["nodes", "texts", "connections", "groups"].includes(value.category) ||
    typeof value.primary !== "boolean"
  )
    return undefined;
  if (
    value.category === "groups" &&
    (!Array.isArray(value.object.ids) ||
      !value.object.ids.every((id: unknown) => typeof id === "string") ||
      typeof value.object.label !== "string")
  )
    return undefined;
  return value as AgentData;
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

export function renderScene(
  scene: SemanticScene,
  current: readonly ExcalidrawElement[] = [],
): ExcalidrawElement[] {
  const existing = new Map(
    current.filter((item) => !item.isDeleted).map((item) => [semanticId(item), item]),
  );
  const labels = new Map(
    current
      .filter((item) => !item.isDeleted && item.type === "text" && item.containerId)
      .map((item) => [item.type === "text" ? item.containerId : null, item]),
  );
  const renderId = (id: string) => existing.get(id)?.id ?? elementId(id);
  const renderLabelId = (id: string) => labels.get(renderId(id))?.id ?? labelId(id);
  const textStyle = (id: string, bound: boolean) => {
    const old = bound ? labels.get(renderId(id)) : existing.get(id);
    return old?.type === "text"
      ? {
          fontSize: old.fontSize,
          fontFamily: old.fontFamily,
          textAlign: old.textAlign,
          verticalAlign: old.verticalAlign,
        }
      : labelDefaults;
  };
  const groupIds = (id: string) => [
    ...(existing.get(id)?.groupIds.filter((group) => !group.startsWith("agent-group:")) ?? []),
    ...scene.groups
      .filter((group) => group.ids.includes(id))
      .map((group) => nativeGroupId(group.id)),
  ];
  const items: ElementInput[] = [];
  for (const node of scene.nodes) {
    const label = {
      ...textStyle(node.id, true),
      id: renderLabelId(node.id),
      text: node.label,
      groupIds: groupIds(node.id),
      customData: data("nodes", node, false),
    };
    items.push({
      ...defaults,
      type: node.kind,
      id: renderId(node.id),
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
      id: renderId(text.id),
      text: text.text,
      x: text.x,
      y: text.y,
      ...textStyle(text.id, false),
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
    const element = measured.get(renderId(node.id))!;
    return { ...node, width: element.width, height: element.height };
  });
  const nodeIds = new Set(nodes.map((node) => renderId(node.id)));
  const finalItems: ElementInput[] = [];
  for (const group of scene.groups) {
    const members = group.ids.map((id) => measured.get(renderId(id))!);
    const x = Math.min(...members.map((item) => item.x)) - 24;
    const y = Math.min(...members.map((item) => item.y)) - 48;
    const title: ElementInput = {
      type: "text",
      id: renderLabelId(group.id),
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
        id: renderId(group.id),
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
      ...textStyle(connection.id, true),
      id: renderLabelId(connection.id),
      text: connection.label,
      groupIds: groups,
      customData: data("connections", connection, false),
    };
    finalItems.push({
      ...defaults,
      type: "arrow",
      id: renderId(connection.id),
      x: start[0],
      y: start[1],
      points,
      start: { id: renderId(from.id) },
      end: { id: renderId(to.id) },
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
  const managed = new Set(
    current
      .filter(
        (element) =>
          previous.has(semanticId(element)) ||
          (element.type === "text" &&
            element.containerId &&
            previous.has(semanticId(existing.get(element.containerId) ?? element))),
      )
      .map((element) => element.id),
  );
  const rendered = renderScene(after, current).map((item) => {
    const old = existing.get(item.id);
    if (!old) return item;
    const meta = agentData(item)!;
    if (!previous.has(meta.object.id) || (meta.primary && semanticId(old) !== meta.object.id))
      throw new Error(`Native element ID ${old.id} already exists. Choose another new ID.`);
    if (!meta.primary) {
      const owner = current.find((element) => semanticId(element) === meta.object.id);
      const boundToOwner = old.type === "text" && old.containerId === owner?.id;
      const groupTitle =
        agentData(old)?.category === "groups" && agentData(old)?.object.id === meta.object.id;
      if (!boundToOwner && !groupTitle)
        throw new Error(`Native element ID ${old.id} already exists. Choose another new ID.`);
    }
    if (old.type !== item.type) return newElementWith({ ...item, version: old.version }, {}, true);
    const objectId = agentData(item)!.object.id;
    if (!old.isDeleted && !changed.has(objectId)) return old;
    const customData =
      agentData(old)?.object.id === meta.object.id
        ? { ...old.customData, drawingAgent: item.customData?.drawingAgent }
        : old.customData;
    const geometry = {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      customData,
      isDeleted: false,
    };
    const groupIds = item.groupIds;
    const boundElements = [
      ...(old.boundElements ?? []).filter((bound) => !managed.has(bound.id)),
      ...(item.boundElements ?? []),
    ];
    if (old.type === "text" && item.type === "text") {
      return newElementWith(old, {
        ...geometry,
        groupIds,
        text: item.text,
        originalText: item.originalText,
        containerId: item.containerId,
      });
    }
    if (old.type === "arrow" && item.type === "arrow") {
      const beforeEdge = before.connections.find((edge) => edge.id === objectId);
      const afterEdge = after.connections.find((edge) => edge.id === objectId);
      return newElementWith(old, {
        ...geometry,
        groupIds,
        boundElements,
        points: item.points,
        startBinding: item.startBinding,
        endBinding: item.endBinding,
        strokeStyle: beforeEdge?.style === afterEdge?.style ? old.strokeStyle : item.strokeStyle,
      });
    }
    return newElementWith(old, { ...geometry, groupIds, boundElements });
  });
  const replacements = new Map(rendered.map((item) => [item.id, item]));
  const previousIds = new Set(sceneObjects(before).map((item) => item.id));
  const removedNativeIds = new Set(
    current
      .filter((item) => previousIds.has(semanticId(item)) && !replacements.has(item.id))
      .map((item) => item.id),
  );
  const retained = current.map((item) => {
    const next = replacements.get(item.id);
    if (next) return next;
    const deleted =
      removedNativeIds.has(item.id) ||
      (agentData(item)?.category === "groups" &&
        previousIds.has(agentData(item)!.object.id) &&
        !after.groups.some((group) => group.id === agentData(item)!.object.id)) ||
      (item.type === "text" && item.containerId !== null && removedNativeIds.has(item.containerId));
    return deleted && !item.isDeleted ? newElementWith(item, { isDeleted: true }) : item;
  });
  return [...retained, ...rendered.filter((item) => !existing.has(item.id))];
}

function semanticId(element: ExcalidrawElement): string {
  const meta = agentData(element);
  return meta?.primary && element.id === elementId(meta.object.id)
    ? meta.object.id
    : `native:${element.id}`;
}

export function readDiagramContext(
  elements: readonly ExcalidrawElement[],
  selected: Readonly<Record<string, boolean>> = {},
): DiagramContext {
  const scene = emptyScene();
  const active = elements.filter((item) => !item.isDeleted);
  const byId = new Map(active.map((item) => [item.id, item]));
  const labels = new Map(
    active
      .filter((item) => item.type === "text" && item.containerId)
      .map((item) => [item.type === "text" ? item.containerId : null, item]),
  );
  const represented = new Set<string>();
  const groups: ExcalidrawElement[] = [];
  const eligible = (item: ExcalidrawElement) =>
    Math.abs(item.angle) < 0.001 &&
    [item.x, item.y, item.width, item.height].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000,
    ) &&
    semanticId(item).length <= 512;
  for (const item of active) {
    if (!eligible(item)) continue;
    const id = semanticId(item);
    const meta = agentData(item);
    if (meta?.primary && meta.category === "groups" && item.id === elementId(meta.object.id)) {
      groups.push(item);
      continue;
    }
    if (meta?.category === "groups" && !meta.primary && byId.has(elementId(meta.object.id)))
      continue;
    const bound = labels.get(item.id);
    const label = bound?.type === "text" ? bound.originalText : "";
    if (
      ["rectangle", "ellipse", "diamond"].includes(item.type) &&
      label.length <= 500 &&
      item.width >= 1 &&
      item.height >= 1 &&
      scene.nodes.length < 500
    ) {
      scene.nodes.push({
        id,
        kind: item.type as SceneNode["kind"],
        label,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
      represented.add(item.id);
      if (bound) represented.add(bound.id);
    } else if (
      item.type === "text" &&
      !item.containerId &&
      item.originalText.length <= 500 &&
      scene.texts.length < 100
    ) {
      scene.texts.push({ id, text: item.originalText, x: item.x, y: item.y });
      represented.add(item.id);
    }
  }
  const nodes = new Set(scene.nodes.map((item) => item.id));
  for (const item of active) {
    if (
      item.type !== "arrow" ||
      !eligible(item) ||
      ("elbowed" in item && item.elbowed) ||
      (item.points.length !== 2 && agentData(item)?.category !== "connections") ||
      scene.connections.length >= 1000
    )
      continue;
    const start = item.startBinding && byId.get(item.startBinding.elementId);
    const end = item.endBinding && byId.get(item.endBinding.elementId);
    if (
      !start ||
      !end ||
      !nodes.has(semanticId(start)) ||
      !nodes.has(semanticId(end)) ||
      start.id === end.id
    )
      continue;
    const bound = labels.get(item.id);
    const label = bound?.type === "text" ? bound.originalText : "";
    if (label.length > 500) continue;
    scene.connections.push({
      id: semanticId(item),
      from: semanticId(start),
      to: semanticId(end),
      label,
      style: item.strokeStyle === "dashed" ? "dashed" : "solid",
    });
    represented.add(item.id);
    if (bound) represented.add(bound.id);
  }
  const members = new Set([...nodes, ...scene.texts.map((item) => item.id)]);
  for (const item of groups.slice(0, 30)) {
    const meta = agentData(item)!;
    if (!("ids" in meta.object)) continue;
    const title = byId.get(labelId(meta.object.id));
    const ids = [
      ...new Set(
        meta.object.ids.filter(
          (id) => members.has(id) && !scene.groups.some((group) => group.ids.includes(id)),
        ),
      ),
    ].slice(0, 100);
    if (!ids.length) continue;
    scene.groups.push({
      id: meta.object.id,
      label:
        title?.type === "text" ? title.originalText.slice(0, 500) : meta.object.label.slice(0, 500),
      ids,
    });
    represented.add(item.id);
    if (title) represented.add(title.id);
  }
  const remaining = active.filter((item) => !represented.has(item.id));
  return {
    scene,
    selectedIds: active
      .filter(
        (item) =>
          selected[item.id] &&
          represented.has(item.id) &&
          !(item.type === "text" && item.containerId),
      )
      .map(semanticId)
      .slice(0, 1000),
    readOnly: remaining.slice(0, 1000).map((item) => ({
      id: semanticId(item).slice(0, 512),
      type: item.type,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      text: item.type === "text" ? item.originalText.slice(0, 500) : "",
      reason:
        "Retain this object. Its type, rotation, size, or text is outside the editable diagram contract.",
    })),
    omitted: Math.max(0, remaining.length - 1000),
  };
}

export function readSemanticScene(elements: readonly ExcalidrawElement[]): SemanticScene {
  return readDiagramContext(elements).scene as SemanticScene;
}
