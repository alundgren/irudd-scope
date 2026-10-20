import { useEffect, useRef, useState } from "react";
import type { LibrarianView } from "@irudd-scope/protocol/librarian";
import { Button } from "../../renderer/components/ui/button.tsx";
import { memoryFields, type MemoryConnections } from "./contract.ts";
import { memoryKind, memoryStage } from "./format.ts";
import type { Navigation } from "./navigation.ts";

const WIDTH = 840;
const HEIGHT = 420;
/**
 * Fixed node centres, filled in order, keep 160×44 nodes apart for every combination of ring
 * counts; memories beyond these slots appear only in the list.
 */
const SLOTS = [
  [],
  [0, 1, 2, 3, 4, 5].map((slot) => {
    const angle = ((slot * 60 - 90) * Math.PI) / 180;
    return { x: WIDTH / 2 + 200 * Math.cos(angle), y: HEIGHT / 2 + 110 * Math.sin(angle) };
  }),
  [
    { x: 420, y: 30 },
    { x: 420, y: 390 },
    { x: 80, y: 210 },
    { x: 760, y: 210 },
    { x: 100, y: 40 },
    { x: 740, y: 40 },
    { x: 100, y: 380 },
    { x: 740, y: 380 },
  ],
];
const short = (text: string) => (text.length > 22 ? `${text.slice(0, 21)}…` : text);

function relation(graph: MemoryConnections, path: string) {
  const out = graph.edges.some((edge) => edge.from === graph.focus && edge.to === path);
  const back = graph.edges.some((edge) => edge.to === graph.focus && edge.from === path);
  const shared = graph.sharedTags.find((entry) => entry.to === path);
  const parts = [
    out && back ? "References each other" : out ? "Referenced by this memory" : "",
    !out && back ? "References this memory" : "",
    !out && !back ? "Linked through another memory" : "",
    shared ? `Shares #${shared.tags.join(" #")} (not a reference)` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

export function ConnectionsView({
  state,
  navigate,
}: {
  state: LibrarianView;
  navigate: (selection: Navigation) => void;
}) {
  const [drawing, setDrawing] = useState(false);
  const graph = state.displayed as MemoryConnections | null;
  const heading = useRef<HTMLParagraphElement>(null);
  const shownFocus = useRef(graph?.focus);
  useEffect(() => {
    // The chosen memory leaves the list, so keyboard focus moves to the line naming it.
    if (graph && shownFocus.current && shownFocus.current !== graph.focus) heading.current?.focus();
    shownFocus.current = graph?.focus;
  }, [graph?.focus]);
  const options = state.connections ?? { depth: 1, sharedTags: false };
  if (!state.focusPath || !graph)
    return (
      <section aria-label="Connections">
        <p>Choose a memory in Browse first. Connections shows the memories it links with.</p>
        <Button variant="secondary" onClick={() => navigate({ view: "browse" })}>
          Browse memories
        </Button>
      </section>
    );
  const focus = graph.nodes.find((node) => node.path === graph.focus);
  const others = graph.nodes
    .filter((node) => node.path !== graph.focus)
    .sort((a, b) => a.distance - b.distance || a.title.localeCompare(b.title));
  const drawn = [1, 2].flatMap((ring) =>
    others.filter((node) => Math.min(node.distance, 2) === ring).slice(0, SLOTS[ring]!.length),
  );
  const position = new Map<string, { x: number; y: number }>([
    [graph.focus, { x: WIDTH / 2, y: HEIGHT / 2 }],
  ]);
  for (const ring of [1, 2])
    drawn
      .filter((node) => Math.min(node.distance, 2) === ring)
      .forEach((node, index) => position.set(node.path, SLOTS[ring]![index]!));
  const broken = graph.edges.filter((edge) => edge.broken);
  const select = (path: string) =>
    navigate({ view: "connections", focusPath: path, connections: options });
  return (
    <section className="librarian-connections" aria-label="Connections">
      <div className="librarian-toolbar">
        <p className="librarian-note" ref={heading} tabIndex={-1}>
          Focused on <strong>{focus?.title ?? graph.focus}</strong>
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            navigate({
              view: "connections",
              connections: { ...options, depth: options.depth === 1 ? 2 : 1 },
            })
          }
        >
          {options.depth === 1 ? "Expand to 2 steps" : "Return to 1 step"}
        </Button>
        <Button
          variant={options.sharedTags ? "secondary" : "outline"}
          size="sm"
          aria-pressed={options.sharedTags}
          onClick={() =>
            navigate({
              view: "connections",
              connections: { ...options, sharedTags: !options.sharedTags },
            })
          }
        >
          Shared tags
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            navigate({ view: "memory", path: graph.focus, trail: [...(state.browse?.trail ?? [])] })
          }
        >
          Read this memory
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="librarian-compact-only"
          aria-expanded={drawing}
          onClick={() => setDrawing(!drawing)}
        >
          {drawing ? "Hide graph" : "Show graph"}
        </Button>
      </div>
      <p className={drawing ? "librarian-legend shown" : "librarian-legend"}>
        <span className="reference">Link, either direction</span>
        <span className="tagged">Shared tag, not a reference</span>
        <span>Explicit links only. A connection is not evidence.</span>
      </p>
      <div className={drawing ? "librarian-graph shown" : "librarian-graph"}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          aria-label="Connection graph. The list below holds the same memories."
        >
          {graph.edges
            .filter((edge) => position.has(edge.from) && position.has(edge.to))
            .map((edge, index) => (
              <line
                key={`e${index}`}
                className="librarian-edge"
                x1={position.get(edge.from)!.x}
                y1={position.get(edge.from)!.y}
                x2={position.get(edge.to)!.x}
                y2={position.get(edge.to)!.y}
              />
            ))}
          {graph.sharedTags
            .filter((entry) => position.has(entry.to))
            .map((entry) => (
              <line
                key={`t${entry.to}`}
                className="librarian-edge tagged"
                x1={WIDTH / 2}
                y1={HEIGHT / 2}
                x2={position.get(entry.to)!.x}
                y2={position.get(entry.to)!.y}
              />
            ))}
          {[...(focus ? [focus] : []), ...drawn].map((node) => {
            const at = position.get(node.path)!;
            const fields = memoryFields(node.memory);
            return (
              <g
                key={node.path}
                className={
                  node.path === graph.focus ? "memory-graph-node focus" : "memory-graph-node"
                }
                role="button"
                tabIndex={0}
                aria-label={`Focus ${node.title}`}
                transform={`translate(${at.x - 80},${at.y - 22})`}
                onClick={() => select(node.path)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  select(node.path);
                }}
              >
                <title>{node.title}</title>
                <rect width="160" height="44" rx="6" />
                <text x="10" y="19">
                  {short(node.title)}
                </text>
                <text x="10" y="35" className="detail">
                  {memoryStage(fields.stage)} · {memoryKind(fields.kind)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="librarian-note">
        {others.length + 1} memories · {options.depth === 1 ? "1 step" : "2 steps"} · up to{" "}
        {graph.limit}
        {graph.truncated ? " · More connections exist than this limit shows." : ""}
        {drawn.length < others.length
          ? ` · The graph draws ${drawn.length + 1}; the list shows all.`
          : ""}
      </p>
      <h3>Connections in a list</h3>
      {others.length ? (
        <ul className="memory-link-list" aria-label="Connected memories">
          {others.map((node) => (
            <li key={node.path}>
              <button onClick={() => select(node.path)}>{node.title}</button>
              <small>{relation(graph, node.path)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No other memory links with this one.</p>
      )}
      {!!broken.length && (
        <>
          <h3>Broken references · {broken.length}</h3>
          <ul className="memory-link-list">
            {broken.map((edge, index) => (
              <li key={`${edge.from}-${edge.to}-${index}`}>
                <span>{edge.label || edge.to}</span>
                <small>
                  {edge.from} points to {edge.to}, which does not exist in this library.
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
