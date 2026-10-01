import { useState, type FormEvent } from "react";
import type { Artifact } from "@irudd-scope/protocol";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import { starterPullRequestsHTML } from "./starter.ts";
export function CreatePullRequests({
  onCreated,
  onClose,
}: {
  onCreated: (artifact: Artifact) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("PR inbox");
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(
        await window.scope.createPullRequests({
          name: name.trim() || `pull-requests-${crypto.randomUUID()}`,
          title: title.trim(),
          repository: {
            owner: repository.trim().split("/")[0],
            name: repository.trim().split("/")[1],
          },
          html: file ? await file.text() : starterPullRequestsHTML,
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not create the PR inbox.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-panel" aria-label="Create PR inbox">
      <div className="section-title">
        <h1>Create PR inbox</h1>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Done
        </Button>
      </div>
      <form className="settings-form" onSubmit={(event) => void create(event)}>
        <label>
          Repository
          <Input
            required
            placeholder="OWNER/REPO"
            pattern="[^/ ]+/[^/ ]+"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
          />
        </label>
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
          The inbox stays in your workspace and uses your existing GitHub CLI login. Share its name
          with your coding agent to customize the app.
        </p>
        <Button type="submit" disabled={busy || !title.trim() || !repository.trim()}>
          {busy ? "Creating…" : "Create PR inbox"}
        </Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
