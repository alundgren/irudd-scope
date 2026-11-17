import { memo, useId } from "react";
import type { CardContent } from "../../contract.ts";
import type { BoxesContent } from "./contract.ts";
import { areas, bounds, connectorPath, connectors, titleOffset, titleWidth } from "./geometry.ts";
import { ArrowTip, Outline } from "./outline.tsx";

const PADDING = 24;

/**
 * The read-only picture on the board: the whole diagram scaled to fit the card frame and
 * centered, so resizing the frame never changes the content.
 */
export const BoxesPicture = memo(function BoxesPicture({ content }: { content: CardContent }) {
  const tip = `boxes-tip${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const records = content as BoxesContent;
  const frame = bounds(records);
  if (!frame) return <span className="canvas-card-empty">Empty diagram</span>;
  const viewBox = [
    frame.x - PADDING,
    frame.y - PADDING,
    frame.w + PADDING * 2,
    frame.h + PADDING * 2,
  ].join(" ");
  return (
    <svg
      className="boxes-picture"
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Diagram"
    >
      <defs>
        <ArrowTip id={tip} />
      </defs>
      {areas(records).map(([id, area]) =>
        area.type === "section" ? (
          <g key={id} transform={`translate(${area.x} ${area.y})`}>
            <rect className="boxes-section" width={area.w} height={area.h} rx={8} />
            <rect
              className="boxes-section-plate"
              x={titleOffset(area, titleWidth(area))}
              y={-15}
              width={titleWidth(area)}
              height={30}
              rx={7}
            />
            <text className="boxes-section-text" x={titleOffset(area, titleWidth(area)) + 9} y={0}>
              {area.text || "Section"}
            </text>
          </g>
        ) : (
          <g key={id} transform={`translate(${area.x} ${area.y})`}>
            <Outline box={area} />
            {area.text && (
              <foreignObject width={area.w} height={area.h}>
                <div className="boxes-label">{area.text}</div>
              </foreignObject>
            )}
          </g>
        ),
      )}
      {connectors(records).map(([id, connector]) => {
        const path = connectorPath(connector, records);
        if (!path) return null;
        return (
          <g key={id}>
            <path
              className="boxes-line"
              d={path.d}
              markerStart={connector.arrowStart ? `url(#${tip})` : undefined}
              markerEnd={connector.arrowEnd === false ? undefined : `url(#${tip})`}
            />
            {connector.label && (
              <text className="boxes-line-text" x={path.middle.x} y={path.middle.y}>
                {connector.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});
