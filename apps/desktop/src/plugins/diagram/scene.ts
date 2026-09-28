import { parseScene, type DiagramOperation, type SemanticScene } from "./contract.ts";

export function sceneObjects(scene: SemanticScene) {
  return [...scene.nodes, ...scene.texts, ...scene.connections, ...scene.groups];
}

export function validateScene(scene: SemanticScene): SemanticScene {
  parseScene(scene);
  const objects = sceneObjects(scene);
  if (new Set(objects.map((item) => item.id)).size !== objects.length) {
    throw new Error("Every object must have a unique semantic ID.");
  }
  const nodes = new Set(scene.nodes.map((item) => item.id));
  for (const edge of scene.connections) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new Error(`Connection ${edge.id} refers to a missing node.`);
    }
    if (edge.from === edge.to)
      throw new Error(`Connection ${edge.id} cannot connect a node to itself.`);
  }
  const members = new Set([...nodes, ...scene.texts.map((item) => item.id)]);
  const grouped = new Set<string>();
  for (const group of scene.groups) {
    for (const member of group.ids) {
      if (!members.has(member))
        throw new Error(`Group ${group.id} refers to missing member ${member}.`);
      if (grouped.has(member)) throw new Error(`Object ${member} belongs to more than one group.`);
      grouped.add(member);
    }
  }
  return scene;
}

export function groupBounds(scene: SemanticScene, ids: string[]) {
  const items = [...scene.nodes, ...scene.texts].filter((item) => ids.includes(item.id));
  if (!items.length) throw new Error("A group needs at least one node or text object.");
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(
    ...items.map(
      (item) => item.x + ("width" in item ? item.width : Math.max(60, item.text.length * 10)),
    ),
  );
  const bottom = Math.max(
    ...items.map(
      (item) => item.y + ("height" in item ? item.height : 28 * item.text.split("\n").length),
    ),
  );
  return { x: left - 24, y: top - 48, width: right - left + 48, height: bottom - top + 72 };
}

export function applyOperations(
  current: SemanticScene,
  operations: readonly DiagramOperation[],
): SemanticScene {
  const scene = structuredClone(current);
  validateScene(scene);
  const exists = (id: string) => sceneObjects(scene).some((item) => item.id === id);
  const requireNew = (id: string) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id))
      throw new Error(
        "New diagram IDs must start with a letter and use at most 64 letters, digits, underscores, or hyphens.",
      );
    if (exists(id)) throw new Error(`ID ${id} already exists. Edit it or choose a new ID.`);
  };
  const requireObject = (id: string) => {
    const item = sceneObjects(scene).find((item) => item.id === id);
    if (!item) throw new Error(`Unknown object ${id}.`);
    return item;
  };

  for (const op of operations) {
    switch (op.type) {
      case "createNode": {
        requireNew(op.id);
        const minimumWidth = op.kind === "diamond" ? 180 : 120;
        const minimumHeight = op.kind === "diamond" ? 110 : 64;
        scene.nodes.push({
          id: op.id,
          kind: op.kind,
          label: op.label,
          x: op.x,
          y: op.y,
          width: Math.max(minimumWidth, op.width ?? 180),
          height: Math.max(minimumHeight, op.height ?? 80),
        });
        break;
      }
      case "createText":
        requireNew(op.id);
        scene.texts.push({ id: op.id, text: op.text, x: op.x, y: op.y });
        break;
      case "connect":
        requireNew(op.id);
        scene.connections.push({
          id: op.id,
          from: op.from,
          to: op.to,
          label: op.label ?? "",
          style: op.style ?? "solid",
        });
        break;
      case "move": {
        const item = requireObject(op.id);
        if ("ids" in item) {
          const bounds = groupBounds(scene, item.ids);
          for (const member of [...scene.nodes, ...scene.texts].filter((member) =>
            item.ids.includes(member.id),
          )) {
            member.x += op.x - bounds.x;
            member.y += op.y - bounds.y;
          }
        } else if ("x" in item) {
          item.x = op.x;
          item.y = op.y;
        } else throw new Error(`Move the endpoints of connection ${op.id} instead.`);
        break;
      }
      case "resize": {
        const item = requireObject(op.id);
        if (!("width" in item)) throw new Error(`Only nodes can be resized: ${op.id}.`);
        item.width = Math.max(item.kind === "diamond" ? 180 : 120, op.width);
        item.height = Math.max(item.kind === "diamond" ? 110 : 64, op.height);
        break;
      }
      case "setLabel": {
        const item = requireObject(op.id);
        if ("text" in item) item.text = op.label;
        else item.label = op.label;
        break;
      }
      case "delete": {
        op.ids.forEach(requireObject);
        const removed = new Set(op.ids);
        scene.nodes = scene.nodes.filter((item) => !removed.has(item.id));
        scene.texts = scene.texts.filter((item) => !removed.has(item.id));
        scene.connections = scene.connections.filter(
          (item) => !removed.has(item.id) && !removed.has(item.from) && !removed.has(item.to),
        );
        scene.groups = scene.groups
          .filter((item) => !removed.has(item.id))
          .map((item) => ({ ...item, ids: item.ids.filter((id) => !removed.has(id)) }))
          .filter((item) => item.ids.length);
        break;
      }
      case "group": {
        const previous = scene.groups.find((item) => item.id === op.id);
        if (!previous) requireNew(op.id);
        const group = { id: op.id, label: op.label, ids: [...new Set(op.ids)] };
        scene.groups = [...scene.groups.filter((item) => item.id !== op.id), group];
        break;
      }
    }
  }
  return validateScene(scene);
}
