import type { NodeEvents } from "./box-node.tsx";
import { BoxNode } from "./box-node.tsx";
import type { BoxesContent } from "./contract.ts";
import { ConnectorLabels, ConnectorLayer, type LineEvents } from "./connector-layer.tsx";
import { ghostOf, type Gesture } from "./gestures.ts";
import { areas, type Guide } from "./geometry.ts";

/** Everything drawn in content coordinates: connectors, boxes, the new-box preview and guides. */
export function DiagramLayer({
  view,
  content,
  selected,
  typing,
  labeling,
  gesture,
  guides,
  zoom,
  editable,
  node,
  line,
}: {
  /** The diagram with the current gesture's draft applied. */
  view: BoxesContent;
  /** The diagram before the gesture. */
  content: BoxesContent;
  selected: string | undefined;
  typing: string | undefined;
  labeling: string | undefined;
  gesture: Gesture | undefined;
  guides: readonly Guide[];
  zoom: number;
  editable: boolean;
  node: NodeEvents;
  line: LineEvents;
}) {
  const ghost = ghostOf(gesture, content, zoom);
  const candidate =
    gesture?.kind === "connect" || gesture?.kind === "endpoint" ? gesture.candidate.id : undefined;
  const source = gesture?.kind === "connect" ? gesture.from.id : undefined;
  return (
    <>
      <ConnectorLayer
        content={view}
        selected={selected}
        gesture={gesture}
        zoom={zoom}
        editable={editable}
        on={line}
      />
      {areas(view).map(([id, area]) => (
        <BoxNode
          key={id}
          id={id}
          area={area}
          selected={id === selected}
          typing={typing === id}
          target={id === candidate && id !== source}
          tools={editable && id === selected && !typing && gesture?.kind !== "draw"}
          on={node}
        />
      ))}
      {ghost && (
        <div
          className="boxes-ghost"
          style={{
            left: ghost.rect.x,
            top: ghost.rect.y,
            width: ghost.rect.w,
            height: ghost.rect.h,
          }}
        />
      )}
      <ConnectorLabels content={view} labeling={labeling} on={line} onPick={line.select} />
      {[...guides, ...(ghost?.guides ?? [])].map((guide) => (
        <div
          key={`${guide.axis}${guide.at}`}
          className={`boxes-guide boxes-guide-${guide.axis}`}
          data-guide={guide.axis}
          style={
            guide.axis === "x"
              ? { left: guide.at, borderLeftWidth: 1 / zoom }
              : { top: guide.at, borderTopWidth: 1 / zoom }
          }
        />
      ))}
    </>
  );
}
