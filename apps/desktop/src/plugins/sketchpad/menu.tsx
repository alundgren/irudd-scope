import { MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { BookOpen, Maximize, Trash2 } from "lucide-react";
import { fitToCanvas } from "./viewport.ts";

export function SketchpadMenu({
  api,
  ready,
  onReset,
}: {
  api: ExcalidrawImperativeAPI | undefined;
  ready: boolean;
  onReset: () => void;
}) {
  return (
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.Item icon={<Maximize />} disabled={!ready} onSelect={() => api && fitToCanvas(api)}>
        Fit to canvas
      </MainMenu.Item>
      <MainMenu.DefaultItems.CommandPalette />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.Item
        icon={<BookOpen />}
        onSelect={() => api?.toggleSidebar({ name: "default", tab: "library" })}
      >
        Library
      </MainMenu.Item>
      <MainMenu.DefaultItems.Help />
      <MainMenu.Item icon={<Trash2 />} disabled={!ready} onSelect={onReset}>
        Reset canvas
      </MainMenu.Item>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
}
