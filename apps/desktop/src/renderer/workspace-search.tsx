import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Input } from "./components/ui/input.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { matchingSettings } from "./settings-view.tsx";

export function WorkspaceSearch({
  open,
  onOpenChange,
  query,
  setQuery,
  artifacts,
  onOpenArtifact,
  onCreateDiagram,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  artifacts: readonly Artifact[];
  onOpenArtifact: (id: string) => void;
  onCreateDiagram: () => void;
  onOpenSettings: (filter?: string) => void;
}) {
  const results = useRef<HTMLDivElement>(null);
  function navigateResults(event: ReactKeyboardEvent) {
    const buttons = Array.from(results.current?.querySelectorAll("button") ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[
        (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1) + buttons.length) %
          buttons.length
      ]?.focus();
    } else if (event.key === "Enter" && index < 0) {
      event.preventDefault();
      buttons[0]?.click();
    }
  }
  const needle = query.trim().toLowerCase();
  const matches = artifacts
    .filter((artifact) =>
      `${artifact.title} ${artifact.kind} ${Object.values(artifact.source ?? {}).join(" ")}`
        .toLowerCase()
        .includes(needle),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const settingMatches = needle ? matchingSettings(needle) : [];
  const showCreate = "create diagram drawing".includes(needle);
  const showSettings = "settings preferences".includes(needle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="search-dialog" onKeyDown={navigateResults}>
        <DialogHeader>
          <DialogTitle>Find artifacts and tools</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="Search artifacts"
          placeholder="Search artifacts, tools, and settings…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <div className="artifact-list" ref={results}>
          {matches.map((artifact) => (
            <button key={artifact.id} onClick={() => onOpenArtifact(artifact.id)}>
              <span>{artifact.title}</span>
              <small>{artifact.kind}</small>
            </button>
          ))}
          {showCreate && (
            <button onClick={onCreateDiagram}>
              <span>Create diagram</span>
              <small>Tool</small>
            </button>
          )}
          {showSettings && (
            <button onClick={() => onOpenSettings()}>
              <span>Settings</span>
              <small>Tool</small>
            </button>
          )}
          {settingMatches.map((section) => (
            <button key={section.id} onClick={() => onOpenSettings(query)}>
              <span>{section.title}</span>
              <small>Setting</small>
            </button>
          ))}
          {!matches.length && !showCreate && !showSettings && !settingMatches.length && (
            <p role="status">No matches. Try another title, tool, or setting.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
