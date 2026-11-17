import { memo, useId, type PointerEvent } from "react";
import { MAX_TEXT, type BoxRecord, type BoxesContent, type ConnectorRecord } from "./contract.ts";
import { candidatePoint, connectorEnds, ghostOf, type Gesture } from "./gestures.ts";
import { connectorPath, connectors, curve, resolve, type Point } from "./geometry.ts";
import { ArrowTip } from "./outline.tsx";

export type LineEvents = {
  select: (event: PointerEvent, id: string) => void;
  endpoint: (event: PointerEvent, id: string, which: "from" | "to") => void;
  label: (id: string, text: string) => void;
  finishLabel: () => void;
};

const Line = memo(function Line({
  id,
  connector,
  from,
  to,
  selected,
  tip,
  on,
}: {
  id: string;
  connector: ConnectorRecord;
  from: BoxRecord;
  to: BoxRecord;
  selected: boolean;
  tip: string;
  on: LineEvents;
}) {
  const path = curve(
    resolve(connector.from, from),
    resolve(connector.to, to),
    connector.from,
    connector.to,
  );
  return (
    <g data-connector-id={id}>
      <path
        className={`boxes-line${selected ? " boxes-line-selected" : ""}`}
        d={path.d}
        markerStart={connector.arrowStart ? `url(#${tip})` : undefined}
        markerEnd={connector.arrowEnd === false ? undefined : `url(#${tip})`}
      />
      <path
        className="boxes-line-hit"
        d={path.d}
        role="button"
        aria-label={`Connector ${connector.label || ""}`.trim()}
        onPointerDown={(event) => on.select(event, id)}
      />
    </g>
  );
});

function Preview({
  gesture,
  content,
  zoom,
  tip,
}: {
  gesture: Gesture | undefined;
  content: BoxesContent;
  zoom: number;
  tip: string;
}) {
  if (gesture?.kind === "endpoint" && !gesture.candidate.id) {
    const connector = content[gesture.id] as ConnectorRecord;
    const fixed = connector[gesture.which === "from" ? "to" : "from"];
    const box = content[fixed.id];
    if (box?.type !== "box") return null;
    const a = resolve(fixed, box);
    const line = curve(a, gesture.candidate, fixed, undefined);
    return <path className="boxes-line boxes-line-selected" d={line.d} />;
  }
  if (gesture?.kind !== "connect") return null;
  const source = content[gesture.from.id];
  if (source?.type !== "box") return null;
  const start = resolve(gesture.from, source);
  const ghost = ghostOf(gesture, content, zoom);
  let end: Point | undefined;
  let endAnchor: { rx: number; ry: number } | undefined;
  if (ghost) {
    const temporary = { ...content, $ghost: { type: "box" as const, ...ghost.rect, z: "0" } };
    const middle = { id: "$ghost", rx: 0.5, ry: 0.5, ...center(ghost.rect) };
    const [, anchor] = connectorEnds(gesture.from, middle, temporary as BoxesContent);
    endAnchor = anchor;
    end = resolve(anchor, temporary.$ghost);
  } else if (gesture.candidate.id !== gesture.from.id) {
    end = candidatePoint(gesture.candidate, content);
    if (gesture.candidate.id) endAnchor = gesture.candidate;
  }
  return (
    <>
      {end && (
        <path
          className="boxes-line boxes-line-preview"
          d={curve(start, end, gesture.from, endAnchor).d}
          markerEnd={`url(#${tip})`}
        />
      )}
      <circle className="boxes-line-start" cx={start.x} cy={start.y} r={7 / zoom} />
    </>
  );
}

const center = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x + r.w / 2,
  y: r.y + r.h / 2,
});

/** Connectors as SVG under the text layer, with their ends while one is selected. */
export function ConnectorLayer({
  content,
  selected,
  gesture,
  zoom,
  editable,
  on,
}: {
  content: BoxesContent;
  selected: string | undefined;
  gesture: Gesture | undefined;
  zoom: number;
  editable: boolean;
  on: LineEvents;
}) {
  const tip = `boxes-tip${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const chosen = selected ? content[selected] : undefined;
  const path = chosen?.type === "connector" ? connectorPath(chosen, content) : undefined;
  return (
    <svg className="boxes-lines" aria-label="Connectors">
      <defs>
        <ArrowTip id={tip} />
      </defs>
      {connectors(content).map(([id, connector]) => {
        const from = content[connector.from.id];
        const to = content[connector.to.id];
        if (from?.type !== "box" || to?.type !== "box") return null;
        return (
          <Line
            key={id}
            id={id}
            connector={connector}
            from={from}
            to={to}
            selected={id === selected}
            tip={tip}
            on={on}
          />
        );
      })}
      <Preview gesture={gesture} content={content} zoom={zoom} tip={tip} />
      {editable &&
        chosen?.type === "connector" &&
        path &&
        (["from", "to"] as const).map((which) => {
          const box = content[chosen[which].id];
          if (box?.type !== "box") return null;
          const at = resolve(chosen[which], box);
          return (
            <circle
              key={which}
              className="boxes-line-end"
              data-end={which}
              cx={at.x}
              cy={at.y}
              r={8 / zoom}
              onPointerDown={(event) => on.endpoint(event, selected!, which)}
            />
          );
        })}
    </svg>
  );
}

/** Connector labels as text, and the label field while one is being typed. */
export function ConnectorLabels({
  content,
  labeling,
  on,
  onPick,
}: {
  content: BoxesContent;
  labeling: string | undefined;
  on: LineEvents;
  onPick: (event: PointerEvent, id: string) => void;
}) {
  return connectors(content).map(([id, connector]) => {
    if (!connector.label && labeling !== id) return null;
    const path = connectorPath(connector, content);
    if (!path) return null;
    const style = { left: path.middle.x, top: path.middle.y };
    if (labeling === id)
      return (
        <input
          key={id}
          className="boxes-line-field"
          aria-label="Connector label"
          placeholder="Connector label"
          autoFocus
          maxLength={MAX_TEXT}
          style={style}
          value={connector.label ?? ""}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => on.label(id, event.currentTarget.value)}
          onBlur={on.finishLabel}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              on.finishLabel();
            }
          }}
        />
      );
    return (
      <div
        key={id}
        className="boxes-line-label"
        style={style}
        onPointerDown={(event) => onPick(event, id)}
      >
        {connector.label}
      </div>
    );
  });
}
