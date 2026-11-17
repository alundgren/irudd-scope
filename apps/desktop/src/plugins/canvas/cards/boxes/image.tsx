import type { CardContent } from "../../contract.ts";
import type { NodeEvents } from "./box-node.tsx";
import type { LineEvents } from "./connector-layer.tsx";
import type { BoxesContent } from "./contract.ts";
import { DiagramLayer } from "./diagram-layer.tsx";
import "./style.css";

const ignore = () => {};
const node: NodeEvents = {
  move: ignore,
  select: ignore,
  resize: ignore,
  connect: ignore,
  title: ignore,
  text: ignore,
  finishText: ignore,
};
const line: LineEvents = { select: ignore, endpoint: ignore, label: ignore, finishLabel: ignore };

/**
 * The whole diagram drawn by the editor's own layer with nothing selected, for the picture
 * card chat's agent gets. Using the editor's layer keeps text wrapping, clipping, curves and
 * label places the same as the person sees them.
 */
export function BoxesImage({ content }: { content: CardContent }) {
  const records = content as BoxesContent;
  return (
    <div className="boxes-editor boxes-image">
      <DiagramLayer
        view={records}
        content={records}
        selected={undefined}
        typing={undefined}
        labeling={undefined}
        gesture={undefined}
        guides={[]}
        highlighted={undefined}
        zoom={1}
        editable={false}
        node={node}
        line={line}
      />
    </div>
  );
}

/** The drawn parts whose edges together make the diagram's extent, connector curves included. */
export const BOXES_IMAGE_PARTS =
  ".boxes-node, .boxes-section-title, .boxes-line, .boxes-line-label";
