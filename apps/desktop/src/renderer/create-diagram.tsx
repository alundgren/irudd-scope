import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { emptyScene } from "../diagram/contract.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";

export function CreateDiagram({
  onCreated,
  onClose,
}: {
  onCreated: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("Architecture");
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await window.scope.generateDiagram({ intent, scene: emptyScene() });
      if (!active.current) return;
      const [{ applyOperations }, { renderScene }, { serializeAsJSON }] = await Promise.all([
        import("../diagram/scene.ts"),
        import("../diagram/canvas.ts"),
        import("@excalidraw/excalidraw"),
      ]);
      const elements = renderScene(applyOperations(emptyScene(), result.operations));
      const artifact = await window.scope.saveDiagram({
        id: crypto.randomUUID(),
        title,
        expectedRevision: 0,
        content: serializeAsJSON(elements, { viewBackgroundColor: "#ffffff" }, {}, "local"),
      });
      console.info("Scope diagram generation", result.metrics);
      if (active.current) onCreated(artifact);
    } catch (failure) {
      if (active.current)
        setError(failure instanceof Error ? failure.message : "Could not create the diagram.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="settings-panel" aria-label="Create diagram">
      <div className="section-title">
        <h1>Create diagram</h1>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Done
        </Button>
      </div>
      <form className="settings-form" onSubmit={(event) => void create(event)}>
        <label>
          Title
          <Input
            required
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          What should the diagram show?
          <Textarea
            required
            value={intent}
            maxLength={16_000}
            rows={8}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="A customer places an order. The kitchen prepares it for delivery."
          />
        </label>
        <p className="secondary">
          Gemini 3.8 Flash via OpenRouter. The result is saved as an editable artifact.
        </p>
        <div className="section-title">
          <Button type="submit" disabled={busy}>
            {busy ? "Generating…" : "Create diagram"}
          </Button>
          {busy && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void window.scope.cancelDiagramGeneration()}
            >
              Cancel
            </Button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
