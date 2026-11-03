import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CanvasItem, ListeningReply } from "./listening-contract.ts";

export function canvasItems(api: ExcalidrawImperativeAPI): CanvasItem[] {
  const elements = api.getSceneElements();
  if (elements.length > 150)
    throw new Error(
      "Listening supports up to 150 canvas elements. Remove some content before retrying.",
    );
  return elements
    .filter((element) => element.type !== "text" || !element.containerId)
    .map((element) => {
      const label = elements.find(
        (item) => item.type === "text" && item.containerId === element.id,
      );
      return {
        id: element.id,
        type: element.type,
        text: (element.type === "text"
          ? element.text
          : label?.type === "text"
            ? label.text
            : ""
        ).slice(0, 1000),
        from: element.type === "arrow" ? (element.startBinding?.elementId ?? null) : null,
        to: element.type === "arrow" ? (element.endBinding?.elementId ?? null) : null,
      };
    });
}

export function canvasVersion(api: ExcalidrawImperativeAPI) {
  return JSON.stringify(
    api.getSceneElements().map(({ id, version, versionNonce }) => [id, version, versionNonce]),
  );
}

export function applyListeningEdits(api: ExcalidrawImperativeAPI, reply: ListeningReply) {
  if (!reply.edits.length) return;
  let elements: ExcalidrawElement[] = [...api.getSceneElementsIncludingDeleted()];
  const visible = () => elements.filter((element) => !element.isDeleted);
  const initial = visible();
  const state = api.getAppState();
  const originX = initial.length
    ? Math.max(...initial.map((e) => e.x + e.width)) + 80
    : -state.scrollX + 80 / state.zoom.value;
  const originY = initial.length
    ? Math.min(...initial.map((e) => e.y))
    : -state.scrollY + 100 / state.zoom.value;
  let added = 0;
  for (const edit of reply.edits) {
    const current = visible().find((element) => element.id === edit.id);
    if (edit.op === "note" || edit.op === "box") {
      if (elements.some((element) => element.id === edit.id) || !edit.text.trim())
        throw new Error("The model returned a duplicate id or empty note. No edits were applied.");
      const x = originX + Math.floor(added / 4) * 320;
      const y = originY + (added++ % 4) * 180;
      const next = convertToExcalidrawElements(
        edit.op === "box"
          ? [
              {
                id: edit.id,
                type: "rectangle",
                x,
                y,
                width: 240,
                height: 120,
                label: { text: edit.text, fontSize: 20, fontFamily: 2 },
              },
            ]
          : [
              {
                id: edit.id,
                type: "text",
                x,
                y,
                text: edit.text,
                fontSize: 20,
                fontFamily: 2,
                width: 260,
              },
            ],
        { regenerateIds: false },
      );
      elements.push(...next);
    } else if (edit.op === "connect") {
      const from = visible().find((element) => element.id === edit.from);
      const to = visible().find((element) => element.id === edit.to);
      if (!from || !to || from.id === to.id || elements.some((element) => element.id === edit.id))
        throw new Error("The model returned an invalid connection. No edits were applied.");
      const dx = to.x + to.width / 2 - (from.x + from.width / 2);
      const dy = to.y + to.height / 2 - (from.y + from.height / 2);
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const x = from.x + from.width / 2 + (horizontal ? Math.sign(dx) * (from.width / 2 + 8) : 0);
      const y = from.y + from.height / 2 + (horizontal ? 0 : Math.sign(dy) * (from.height / 2 + 8));
      const endX = to.x + to.width / 2 - (horizontal ? Math.sign(dx) * (to.width / 2 + 8) : 0);
      const endY = to.y + to.height / 2 - (horizontal ? 0 : Math.sign(dy) * (to.height / 2 + 8));
      const next = convertToExcalidrawElements(
        [
          {
            id: edit.id,
            type: "arrow",
            x,
            y,
            points: [
              [0, 0],
              [endX - x, endY - y],
            ],
            ...(edit.text ? { label: { text: edit.text, fontSize: 16, fontFamily: 2 } } : {}),
          },
        ],
        { regenerateIds: false },
      );
      elements = elements.map((element) =>
        element.id === from.id || element.id === to.id
          ? newElementWith(element, {
              boundElements: [...(element.boundElements ?? []), { id: edit.id, type: "arrow" }],
            })
          : element,
      );
      // Conversion cannot resolve bindings to objects outside its input list.
      elements.push(
        ...next.map((element) =>
          element.type === "arrow"
            ? newElementWith(element, {
                startBinding: { elementId: from.id, focus: 0, gap: 8 },
                endBinding: { elementId: to.id, focus: 0, gap: 8 },
              })
            : element,
        ),
      );
    } else {
      if (!current) throw new Error("The canvas item no longer exists. No edits were applied.");
      if (edit.op === "remove") {
        const removed = new Set([
          current.id,
          ...(current.boundElements ?? [])
            .filter((bound) => bound.type === "text")
            .map((bound) => bound.id),
        ]);
        for (const element of visible())
          if (
            element.type === "arrow" &&
            (removed.has(element.startBinding?.elementId ?? "") ||
              removed.has(element.endBinding?.elementId ?? ""))
          ) {
            removed.add(element.id);
            element.boundElements
              ?.filter((bound) => bound.type === "text")
              .forEach((bound) => removed.add(bound.id));
          }
        elements = elements.map((element) =>
          removed.has(element.id)
            ? newElementWith(element, { isDeleted: true })
            : newElementWith(element, {
                boundElements:
                  element.boundElements?.filter((bound) => !removed.has(bound.id)) ?? null,
              }),
        );
      } else {
        const label =
          current.type === "text"
            ? current
            : visible().find(
                (element) => element.type === "text" && element.containerId === current.id,
              );
        if (label?.type !== "text" || !edit.text.trim())
          throw new Error("The item has no editable text. No edits were applied.");
        const [updated] = convertToExcalidrawElements(
          [{ ...label, text: edit.text, originalText: edit.text }],
          { regenerateIds: false },
        );
        elements = elements.map((element) =>
          element.id === label.id
            ? newElementWith(label, {
                text: edit.text,
                originalText: edit.text,
                width: updated.width,
                height: updated.height,
              })
            : element,
        );
      }
    }
  }
  if (visible().length > 150)
    throw new Error("The update exceeds the 150-element listening limit. No edits were applied.");
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}
