import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";
import type { MemoryDraft, MemoryConcept } from "./contract.ts";

export function MemoryEditor({
  draft,
  saving,
  enabled,
  incoming,
  onChange,
  onSave,
  onDiscard,
  onCompare,
  onUseIncoming,
  onUseBase,
  onNotice,
  onError,
}: {
  draft: MemoryDraft;
  saving: boolean;
  enabled: boolean;
  incoming?: MemoryConcept;
  onChange: (raw: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onCompare: () => void;
  onUseIncoming: () => void;
  onUseBase: () => void;
  onNotice: (notice: string) => void;
  onError: (error: string) => void;
}) {
  const [discarding, setDiscarding] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirmBase, setConfirmBase] = useState(false);
  useEffect(() => setConfirmBase(false), [incoming]);
  return (
    <section className="memory-editor" aria-label="Edit memory note">
      <div className="memory-note-actions">
        <strong>Editing {draft.path}</strong>
        <small>{draft.repository}</small>
        <Button variant="default" size="sm" disabled={!enabled || saving} onClick={onSave}>
          {saving ? "Saving…" : "Save note"}
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDiscarding(true)}>
          Discard draft
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void window.scope.copyMemoryDraft(draft.raw).then(
              () => onNotice("Draft copied."),
              (cause: unknown) =>
                onError(
                  cause instanceof Error ? cause.message : "Could not copy the draft. Retry.",
                ),
            )
          }
        >
          Copy draft
        </Button>
        <Button variant="ghost" size="sm" disabled={!enabled || saving} onClick={onCompare}>
          Compare saved version
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          Preview draft
        </Button>
      </div>
      {!enabled && (
        <p role="status">
          This draft belongs to {draft.repository}. It stays here until you return to that
          repository, copy it, or discard it.
        </p>
      )}
      {discarding && (
        <div className="memory-note-actions" role="alert">
          <span>Discard this retained draft?</span>
          <Button variant="destructive" size="sm" disabled={saving} onClick={onDiscard}>
            Discard changes
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>
            Keep editing
          </Button>
        </div>
      )}
      <Textarea
        aria-label="Memory Markdown"
        value={draft.raw}
        maxLength={1_000_000}
        disabled={saving}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
      {preview && (
        <article className="memory-wiki markdown-document" aria-label="Draft preview">
          <ReactMarkdown
            skipHtml
            components={{
              a: ({ children }) => <span>{children}</span>,
              img: ({ alt }) => <span>{alt}</span>,
            }}
          >
            {draft.raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
          </ReactMarkdown>
        </article>
      )}
      {incoming && (
        <div className="memory-comparison">
          <h2>Current saved version</h2>
          <p>
            {incoming.hash === draft.expectedHash
              ? "The saved file still matches the version you started editing."
              : "The saved file changed since this draft started. Your draft is unchanged."}
          </p>
          <pre>{incoming.raw}</pre>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => setConfirmBase(true)}
          >
            Use saved version as base
          </Button>
          {confirmBase && (
            <div className="memory-note-actions" role="alert">
              <span>
                Keep your edited Markdown and use this reviewed saved version for the next conflict
                check?
              </span>
              <Button variant="secondary" size="sm" disabled={saving} onClick={onUseBase}>
                Keep draft and confirm base
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmBase(false)}>
                Cancel
              </Button>
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={() => setDiscarding(true)}>
            Review discarding draft
          </Button>
          {discarding && (
            <Button variant="destructive" size="sm" disabled={saving} onClick={onUseIncoming}>
              Discard draft and use saved version
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
