import type { NativeDiagram } from "@irudd-scope/protocol/diagram-sync";

export function nativeDiagram(count = 24, imageBytes = 0): NativeDiagram {
  const elements: Record<string, unknown>[] = [];
  const types = [
    "rectangle",
    "ellipse",
    "diamond",
    "text",
    "line",
    "arrow",
    "freedraw",
    "frame",
    "magicframe",
    "embeddable",
    "iframe",
    "image",
  ];
  for (let index = 0; index < count; index++) {
    const type = types[index % types.length];
    const element: Record<string, unknown> = {
      id: `object-${index}`,
      type,
      x: (index % 6) * 240,
      y: Math.floor(index / 6) * 200,
      width: 160,
      height: 100,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#a5d8ff",
      fillStyle: "hachure",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: index + 1,
      version: 1,
      versionNonce: index + 100,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    };
    if (type === "text")
      Object.assign(element, {
        text: `Object ${index}`,
        originalText: `Object ${index}`,
        fontSize: 24,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
        height: 30,
      });
    if (["line", "arrow", "freedraw"].includes(type))
      Object.assign(element, {
        points: [
          [0, 0],
          [80, 30],
          [160, 100],
        ],
        lastCommittedPoint: null,
      });
    if (type === "line" || type === "arrow")
      Object.assign(element, {
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: type === "arrow" ? "arrow" : null,
      });
    if (type === "arrow" && index >= 12)
      Object.assign(element, {
        elbowed: true,
        points: [
          [0, 0],
          [160, 0],
          [160, 100],
        ],
        fixedSegments: null,
        startIsSpecial: false,
        endIsSpecial: false,
      });
    if (type === "freedraw")
      Object.assign(element, { pressures: [0.4, 0.9, 0.5], simulatePressure: false });
    if (type === "frame" || type === "magicframe")
      Object.assign(element, { name: `${type} ${index}`, width: 200, height: 150 });
    if (type === "embeddable") element.link = "https://example.com/";
    if (type === "image")
      Object.assign(element, {
        fileId: "sample-image",
        status: "saved",
        scale: [1, 1],
        crop: null,
      });
    elements.push(element);
  }
  if (elements.length >= 24) {
    elements[0].groupIds = ["sample-group"];
    elements[1].groupIds = ["sample-group"];
    elements[0].boundElements = [
      { id: "object-3", type: "text" },
      { id: "object-5", type: "arrow" },
    ];
    elements[3].containerId = "object-0";
    elements[5].startBinding = { elementId: "object-0", focus: 0, gap: 5 };
    elements[12].frameId = "object-7";
    elements[2].angle = 0.25;
    elements[13].locked = true;
    elements[1].customData = { example: "Preserve native extension data" };
  }
  let svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#4263eb"/>';
  let index = 0;
  while (svg.length < imageBytes) {
    svg += `<rect x="${index % 128}" y="${Math.floor(index / 128) % 128}" width="1" height="1" fill="#${((index * 2654435761) >>> 0).toString(16).slice(0, 6).padStart(6, "0")}"/>`;
    index++;
  }
  svg += "</svg>";
  return {
    type: "excalidraw",
    version: 2,
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20, gridStep: 5, gridModeEnabled: false },
    files:
      count >= 12
        ? {
            "sample-image": {
              id: "sample-image",
              mimeType: "image/svg+xml",
              dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
              created: 1,
              lastRetrieved: 1,
            },
          }
        : {},
  };
}
