import type { BoxRecord } from "./contract.ts";

const QUEUE = "M 15 1 C -4 1 -4 99 15 99 L 85 99 C 104 99 104 1 85 1 Z M 15 1 C 34 1 34 99 15 99";
const DIAMOND = "M 50 1 L 99 50 L 50 99 L 1 50 Z";

/** A box's outline in its own coordinates, drawn the same in the editor and the picture. */
export function Outline({ box, className = "" }: { box: BoxRecord; className?: string }) {
  const { w, h } = box;
  const outline = `boxes-outline ${className}`;
  if (box.kind === "diamond" || box.kind === "queue")
    return (
      <path
        className={outline}
        d={box.kind === "diamond" ? DIAMOND : QUEUE}
        transform={`scale(${w / 100} ${h / 100})`}
        vectorEffect="non-scaling-stroke"
      />
    );
  if (box.kind === "circle")
    return <ellipse className={outline} cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />;
  if (box.kind === "database")
    return (
      <>
        <rect className={outline} width={w} height={h} rx={w / 2} ry={h * 0.15} />
        <ellipse className={outline} cx={w / 2} cy={h * 0.14} rx={w / 2} ry={h * 0.14} />
      </>
    );
  return <rect className={outline} width={w} height={h} rx={18} />;
}

/** The arrowhead marker connectors use; it takes the colour of its line. */
export function ArrowTip({ id }: { id: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
    </marker>
  );
}
