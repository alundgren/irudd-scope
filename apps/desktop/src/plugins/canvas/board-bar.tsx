import { LayoutGrid, Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { MAX_ZOOM, MIN_ZOOM } from "./camera.ts";

/** The small bar at the bottom of the board. */
export function BoardBar({
  zoom,
  editable,
  onZoom,
  onFit,
  onArrange,
}: {
  zoom: number;
  editable: boolean;
  onZoom: (direction: 1 | -1) => void;
  onFit: () => void;
  onArrange: () => void;
}) {
  return (
    <div className="canvas-bar" role="toolbar" aria-label="View">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Zoom out"
        title="Zoom out · Ctrl+−"
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onZoom(-1)}
      >
        <ZoomOut />
      </Button>
      <span className="canvas-zoom" aria-label="Zoom level">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Zoom in"
        title="Zoom in · Ctrl+="
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoom(1)}
      >
        <ZoomIn />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Fit" title="Fit all cards" onClick={onFit}>
        <Maximize />
      </Button>
      {editable && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Arrange"
          title="Arrange the selected cards, or all cards"
          onClick={onArrange}
        >
          <LayoutGrid />
        </Button>
      )}
    </div>
  );
}
