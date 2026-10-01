import { useState, type FormEvent } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";

const starterHTML =
  '<!doctype html><html><head><meta charset="utf-8"><style>body{font:18px/1.6 system-ui;margin:48px auto;padding:0 24px;max-width:800px;color:#202026;background:#fff}h1{font-size:32px}</style></head><body><h1>Your plan</h1><p>Share this plan\'s name with your coding agent to publish HTML here.</p></body></html>';

export function CreatePlan({
  onCreated,
  onClose,
}: {
  onCreated: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("Plan");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const stableName = name.trim() || `plan-${crypto.randomUUID()}`;
      const artifact = await window.scope.createPlan({
        name: stableName,
        title: title.trim(),
        html: file ? await file.text() : starterHTML,
      });
      onCreated(artifact);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create the plan.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-panel" aria-label="Create plan">
      <div className="section-title">
        <h1>Create plan</h1>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Done
        </Button>
      </div>
      <form className="settings-form" onSubmit={(event) => void create(event)}>
        <label>
          Title
          <Input
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Name, optional
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Generated automatically"
          />
        </label>
        <label>
          HTML file, optional
          <Input
            type="file"
            accept=".html,.htm,text/html"
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        <p className="secondary">
          Plans stay in your workspace. Your coding agent uses the name to read feedback and publish
          revisions.
        </p>
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? "Creating…" : "Create plan"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
