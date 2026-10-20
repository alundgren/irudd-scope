import { Button } from "../../renderer/components/ui/button.tsx";
import { memoryFields, type MemoryChangeSummary, type MemoryConcept } from "./contract.ts";
import {
  action,
  actor,
  applicability,
  memoryKind,
  memoryStage,
  outcome,
  review,
  time,
} from "./format.ts";
import { MemoryWiki } from "./wiki.tsx";

export function ChangeItem({
  change,
  onOpen,
}: {
  change: MemoryChangeSummary;
  onOpen?: () => void;
}) {
  const title = `${action(change.action)} ${change.title || change.path}`;
  return (
    <>
      {onOpen ? <button onClick={onOpen}>{title}</button> : <strong>{title}</strong>}
      <small>
        {time(change.createdAt)} · {outcome(change.status)} · Proposed by {actor(change.actor)}
        {change.decidedBy.map(
          (decision) =>
            ` · ${decision.decision === "accept" ? "Accepted" : "Rejected"} by ${actor(decision.actor)}`,
        )}
      </small>
      {change.stageChange && (
        <small>
          Stage {memoryStage(change.stageChange.from)} → {memoryStage(change.stageChange.to)}
        </small>
      )}
      <small>{change.reason}</small>
    </>
  );
}

export function Reader({
  concept,
  trail,
  section,
  returning,
  onOpen,
  onBack,
  onResults,
  onTag,
  onSection,
  onChange,
  onReturn,
  onError,
}: {
  concept: MemoryConcept;
  trail: readonly string[];
  section: "connections" | "changes";
  returning: boolean;
  onOpen: (path: string) => void;
  onBack: () => void;
  onResults: () => void;
  onTag: (tag: string) => void;
  onSection: (section: "connections" | "changes") => void;
  onChange?: (id: string) => void;
  onReturn?: () => void;
  onError: (message: string) => void;
}) {
  const fields = memoryFields(concept.memory);
  const internal = concept.links.filter((link) => !link.external);
  const external = concept.links.filter((link) => link.external);
  return (
    <section className="librarian-reader" aria-label="Memory">
      <div className="memory-note-actions">
        <Button variant="ghost" className="librarian-narrow-only" onClick={onResults}>
          Back to results
        </Button>
        {!!trail.length && (
          <Button variant="ghost" onClick={onBack}>
            Back to previous memory
          </Button>
        )}
        {returning && onReturn && (
          <Button variant="ghost" onClick={onReturn}>
            Back to change
          </Button>
        )}
      </div>
      <p className="librarian-labels" aria-label="Memory details">
        {[
          memoryStage(fields.stage),
          memoryKind(fields.kind),
          `Applies: ${applicability(fields.applicability)}`,
          review(fields),
          ...(fields.archived ? ["Archived"] : []),
          ...(fields.deprecated ? ["Deprecated"] : []),
        ].map((label, index) => (
          <span key={label}>
            {index ? " · " : ""}
            <span>{label}</span>
          </span>
        ))}
      </p>
      <p className="librarian-path">{concept.path} · Accepted content</p>
      {!!concept.tags.length && (
        <div className="librarian-tags" aria-label="Tags">
          {concept.tags.map((tag) => (
            <Button key={tag} variant="outline" size="sm" onClick={() => onTag(tag)}>
              #{tag}
            </Button>
          ))}
        </div>
      )}
      <MemoryWiki concept={concept} onOpen={onOpen} onError={onError} />
      <div className="librarian-sections" role="group" aria-label="Memory context">
        {(["connections", "changes"] as const).map((value) => (
          <Button
            key={value}
            variant={section === value ? "secondary" : "ghost"}
            aria-pressed={section === value}
            onClick={() => onSection(value)}
          >
            {value === "connections" ? "Connections" : "Recorded changes"}
          </Button>
        ))}
      </div>
      {section === "connections" ? (
        <>
          <h3>References · {internal.length}</h3>
          {internal.length ? (
            <ul className="memory-link-list" aria-label="References">
              {internal.map((link, index) => (
                <li key={`${link.target}-${index}`}>
                  {link.broken ? (
                    <>
                      <span>{link.label}</span>
                      <small>
                        Broken reference: {link.target} does not exist in this library. Ask your
                        agent to repair or remove it.
                      </small>
                    </>
                  ) : (
                    <>
                      <button onClick={() => onOpen(link.target)}>{link.label}</button>
                      <small>{link.target}</small>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>This memory references no other memories.</p>
          )}
          {!!external.length && (
            <>
              <h3>Web links · {external.length}</h3>
              <ul className="memory-link-list" aria-label="Web links">
                {external.map((link, index) => (
                  <li key={`${link.target}-${index}`}>
                    <button
                      onClick={() =>
                        void window.scope
                          .openMemoryLink(link.target)
                          .catch(() => onError("Could not open the browser. Retry."))
                      }
                    >
                      {link.label}
                    </button>
                    <small>{link.target}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Backlinks · {concept.backlinks.length}</h3>
          {concept.backlinks.length ? (
            <ul className="memory-link-list" aria-label="Backlinks">
              {concept.backlinks.map((link) => (
                <li key={link.path}>
                  <button onClick={() => onOpen(link.path)}>{link.title}</button>
                  <small>{link.path}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No other memory references this one.</p>
          )}
        </>
      ) : concept.changes ? (
        <>
          <h3>Recorded changes</h3>
          {concept.changes.items.length ? (
            <ul className="memory-link-list" aria-label="Recorded changes">
              {concept.changes.items.map((change) => (
                <li key={change.id}>
                  <ChangeItem
                    change={change}
                    onOpen={onChange ? () => onChange(change.id) : undefined}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p>No recorded changes for this memory.</p>
          )}
          <p className="librarian-note">
            {concept.changes.partial
              ? `Showing changes found in the latest ${concept.changes.scanned} recorded changes. `
              : ""}
            Changes made under an earlier file name and edits outside recorded changes are not
            shown.
          </p>
        </>
      ) : concept.changesUnavailable ? (
        <p role="alert">Recorded changes could not be read. The memory is unchanged.</p>
      ) : (
        <p role="status">Reading recorded changes…</p>
      )}
    </section>
  );
}
