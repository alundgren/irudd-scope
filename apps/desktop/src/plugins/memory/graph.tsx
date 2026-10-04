import { useMemo, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import type { MemoryGraph } from "./contract.ts";

function positions(graph: MemoryGraph) {
  const nodes = graph.nodes.map((node, index) => ({
    ...node,
    id: `${node.bundle}:${node.path}`,
    x: 500 + Math.cos(index * 2.39996) * (90 + Math.sqrt(index) * 45),
    y: 350 + Math.sin(index * 2.39996) * (70 + Math.sqrt(index) * 28),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<typeof node>()]));
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from && to) {
      neighbors.get(from.id)?.add(to);
      neighbors.get(to.id)?.add(from);
    }
  }
  for (let step = 0; step < 100; step++) {
    for (const a of nodes) {
      let dx = (500 - a.x) * 0.005;
      let dy = (350 - a.y) * 0.005;
      for (const b of nodes) {
        if (a === b) continue;
        const x = a.x - b.x;
        const y = a.y - b.y;
        const distance = Math.max(100, x * x + y * y);
        dx += (x * 800) / distance;
        dy += (y * 800) / distance;
      }
      for (const other of neighbors.get(a.id) ?? []) {
        dx += (other.x - a.x) * 0.004;
        dy += (other.y - a.y) * 0.004;
      }
      a.x = Math.max(95, Math.min(905, a.x + Math.max(-12, Math.min(12, dx))));
      a.y = Math.max(45, Math.min(655, a.y + Math.max(-12, Math.min(12, dy))));
    }
  }
  return { nodes, byId };
}

export function MemoryGraphView({
  graph,
  onOpen,
}: {
  graph: MemoryGraph;
  onOpen: (path: string) => void;
}) {
  const { nodes, byId } = useMemo(() => positions(graph), [graph]);
  const [zoom, setZoom] = useState(1);
  if (!nodes.length)
    return (
      <p role="status">
        No notes in this graph yet. Open the wiki index to browse your memory files.
      </p>
    );
  return (
    <section className="memory-graph" aria-label="Memory graph">
      <div className="memory-graph-controls">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out graph"
          disabled={zoom <= 1}
          onClick={() => setZoom((value) => value - 0.5)}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in graph"
          disabled={zoom >= 3}
          onClick={() => setZoom((value) => value + 0.5)}
        >
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reset graph zoom"
          onClick={() => setZoom(1)}
        >
          <RotateCcw />
        </Button>
        <span className="secondary">{nodes.length} notes. Select one to open it.</span>
      </div>
      <div className="memory-graph-scroll">
        <svg
          viewBox="0 0 1000 700"
          style={{ width: `${zoom * 100}%` }}
          aria-label="Linked memory notes"
        >
          {graph.edges.map((edge, index) => {
            const a = byId.get(edge.from);
            const b = byId.get(edge.to);
            return a && b ? (
              <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="memory-graph-edge" />
            ) : null;
          })}
          {nodes.map((node) => (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`Open note ${node.title}`}
              className="memory-graph-node"
              transform={`translate(${node.x},${node.y})`}
              onClick={() => onOpen(node.path)}
              onKeyDown={(event) => {
                if (["Enter", " "].includes(event.key)) {
                  event.preventDefault();
                  onOpen(node.path);
                }
              }}
            >
              <title>
                {node.title} · {node.path}
              </title>
              <rect x={-88} y={-19} width={176} height={38} rx={6} />
              <text textAnchor="middle" dominantBaseline="central">
                {node.title.length > 23 ? `${node.title.slice(0, 22)}…` : node.title}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {graph.truncated && (
        <p role="status">
          Showing up to 80 notes. Open a note and select Nearby notes to see its connections.
        </p>
      )}
      <details>
        <summary>All notes in this graph</summary>
        <ul className="memory-link-list">
          {nodes.map((node) => (
            <li key={node.id}>
              <button onClick={() => onOpen(node.path)}>{node.title}</button>
              <small>{node.path}</small>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
