import { useEffect, useRef } from "react";
import type { LibrarianView } from "@irudd-scope/protocol/librarian";
import { Button } from "../../renderer/components/ui/button.tsx";
import {
  memoryFields,
  type MemoryStageName,
  type MemoryStages,
  type MemorySummary,
} from "./contract.ts";
import { applicability, memoryKind, memoryStage, review } from "./format.ts";
import type { Navigation } from "./navigation.ts";
import { ChangeItem } from "./reader.tsx";

const STAGES: { stage: MemoryStageName; description: string }[] = [
  { stage: "bronze", description: "Source observations" },
  { stage: "silver", description: "Normalized, attributable knowledge" },
  { stage: "gold", description: "Curated guidance with checked evidence and limits" },
  { stage: "none", description: "Notes without memory metadata" },
];

export function StagesView({
  state,
  navigate,
  onChange,
}: {
  state: LibrarianView;
  navigate: (selection: Navigation) => void;
  onChange?: (id: string) => void;
}) {
  const stages = state.displayed as MemoryStages | null;
  const history = useRef<HTMLHeadingElement>(null);
  const shown = !!stages?.selected?.transitions;
  const asked = useRef<string>(undefined);
  useEffect(() => {
    // After asking for the history, keyboard focus moves to it instead of the removed button.
    if (shown && asked.current === stages?.selected?.summary.path) history.current?.focus();
    if (shown) asked.current = undefined;
  }, [shown, stages?.selected?.summary.path]);
  if (!stages) return <p role="status">Reading stages…</p>;
  const choose = (path: string) => navigate({ view: "stages", focusPath: path });
  const item = (memory: MemorySummary) => {
    const fields = memoryFields(memory.memory);
    return (
      <li key={memory.path}>
        <button
          aria-current={memory.path === state.focusPath ? "true" : undefined}
          onClick={() => choose(memory.path)}
        >
          {memory.title}
        </button>
        <small>
          {memoryKind(fields.kind)} · {applicability(fields.applicability)} · {review(fields)}
        </small>
      </li>
    );
  };
  const selected = stages.selected;
  const fields = selected ? memoryFields(selected.summary.memory) : undefined;
  return (
    <section className="librarian-stages" aria-label="Stages">
      <p className="librarian-note">
        Accepted memories by processing stage. A stage is not an approval; review is shown
        separately.
      </p>
      {stages.page ? (
        <section aria-label={memoryStage(stages.page.stage)}>
          <Button
            variant="ghost"
            onClick={() => navigate({ view: "stages", stages: { offset: 0 } })}
          >
            All stages
          </Button>
          <h3>
            {memoryStage(stages.page.stage)} · {stages.page.total}
          </h3>
          <ul className="memory-link-list">{stages.page.items.map(item)}</ul>
          <div className="memory-note-actions">
            {stages.page.offset > 0 && (
              <Button
                variant="ghost"
                onClick={() =>
                  navigate({
                    view: "stages",
                    stages: {
                      stage: stages.page!.stage,
                      offset: Math.max(0, stages.page!.offset - 20),
                    },
                  })
                }
              >
                Previous
              </Button>
            )}
            {stages.page.offset + 20 < stages.page.total && (
              <Button
                variant="ghost"
                onClick={() =>
                  navigate({
                    view: "stages",
                    stages: { stage: stages.page!.stage, offset: stages.page!.offset + 20 },
                  })
                }
              >
                Next
              </Button>
            )}
          </div>
        </section>
      ) : (
        <div className="librarian-stage-grid">
          {STAGES.filter(({ stage }) => stage !== "none" || stages.counts.none > 0).map(
            ({ stage, description }) => (
              <section
                key={stage}
                className={`librarian-stage ${stage}`}
                aria-label={memoryStage(stage)}
              >
                <h3>
                  {memoryStage(stage)} <small>{stages.counts[stage]}</small>
                </h3>
                <p className="librarian-note">{description}</p>
                <ul className="memory-link-list">{stages.columns?.[stage].map(item)}</ul>
                {stages.counts[stage] > (stages.columns?.[stage].length ?? 0) && (
                  <Button
                    variant="ghost"
                    onClick={() => navigate({ view: "stages", stages: { stage, offset: 0 } })}
                  >
                    Show all {stages.counts[stage]}
                  </Button>
                )}
                {!stages.counts[stage] && <p>None yet.</p>}
              </section>
            ),
          )}
        </div>
      )}
      {selected && fields && (
        <section className="librarian-stage-detail" aria-label="Stage history">
          <h3>{selected.summary.title}</h3>
          <p className="librarian-labels">
            <span>{memoryStage(fields.stage)}</span>
            <span>{review(fields)}</span>
            <span>Applies: {applicability(fields.applicability)}</span>
          </p>
          {selected.transitions ? (
            <>
              <h4 ref={history} tabIndex={-1}>
                Recorded stage changes
              </h4>
              {selected.transitions.length ? (
                <ul className="memory-link-list">
                  {selected.transitions.map((change) => (
                    <li key={change.id}>
                      <ChangeItem
                        change={change}
                        onOpen={onChange ? () => onChange(change.id) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No recorded stage change.</p>
              )}
              <p className="librarian-note">
                {selected.partial
                  ? `Searched the latest ${selected.scanned} recorded changes only. `
                  : ""}
                Changes made under an earlier file name and edits outside recorded changes are not
                shown.
              </p>
            </>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                asked.current = selected.summary.path;
                choose(selected.summary.path);
              }}
            >
              Show recorded stage changes
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => navigate({ view: "memory", path: selected.summary.path })}
          >
            Read this memory
          </Button>
        </section>
      )}
    </section>
  );
}
