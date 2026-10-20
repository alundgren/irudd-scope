import type { LibrarianActivity, LibrarianView } from "@irudd-scope/protocol/librarian";
import { Button } from "../../renderer/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "../../renderer/components/ui/native-select.tsx";
import type { MemoryActivity } from "./contract.ts";
import { action, actor, outcome, time } from "./format.ts";
import type { Navigation } from "./navigation.ts";
import { ChangeItem } from "./reader.tsx";
import { Markdown } from "./wiki.tsx";

const body = (raw: string | null | undefined) =>
  raw === null || raw === undefined ? null : raw.replace(/^---\n[\s\S]*?\n---\n/, "");

function Evidence({
  revision,
  onBack,
  onCurrent,
}: {
  revision: NonNullable<MemoryActivity["revision"]>;
  onBack: () => void;
  onCurrent: () => void;
}) {
  return (
    <section className="librarian-detail" aria-label="Recorded evidence revision">
      <Button variant="ghost" onClick={onBack}>
        Back to change
      </Button>
      <p className="librarian-note">Recorded evidence revision · read-only</p>
      <h2>{revision.path}</h2>
      <p className="librarian-path">{revision.hash}</p>
      {revision.raw === null ? (
        <p>
          {revision.otherBundle
            ? "This source is in another library. Scope reads only the personal library."
            : revision.unreadable
              ? "The recorded bytes could not be read. Go back to the change and open the source again."
              : revision.partial
                ? `Not found in the latest ${revision.scanned} recorded changes.`
                : "No recorded change contains these bytes."}
        </p>
      ) : (
        <>
          {revision.current && (
            <p className="librarian-note">These bytes match the current accepted memory.</p>
          )}
          <Markdown text={body(revision.raw) ?? ""} />
        </>
      )}
      {!revision.otherBundle && (
        <>
          <p className="librarian-note">
            The current accepted memory can differ from this revision.
          </p>
          <Button variant="secondary" onClick={onCurrent}>
            Open current accepted memory
          </Button>
        </>
      )}
    </section>
  );
}

function Detail({
  activity,
  options,
  busy,
  navigate,
}: {
  activity: MemoryActivity;
  options: LibrarianActivity;
  busy: boolean;
  navigate: (selection: Navigation) => void;
}) {
  const { change, run } = activity.selected!;
  const reviews = change.reviews ?? (change.review ? [change.review] : []);
  const before = change.display?.beforeBody ?? body(change.before?.raw);
  const after = change.display?.afterBody ?? body(change.after?.raw);
  return (
    <section className="librarian-detail" aria-label="Change">
      <Button
        variant="ghost"
        className="librarian-narrow-only"
        onClick={() =>
          navigate({ view: "activity", activity: { ...options, changeId: undefined } })
        }
      >
        Back to list
      </Button>
      <p className="librarian-note">
        {action(change.action)} · {outcome(change.status)}
      </p>
      <h2>{change.display?.title || change.path}</h2>
      <p className="librarian-path">
        {change.path} · {time(change.createdAt)}
      </p>
      <dl className="librarian-facts">
        <dt>Proposed by</dt>
        <dd>{actor(change.actor)}</dd>
        <dt>Decided by</dt>
        <dd>
          {reviews.length
            ? reviews.map((review, index) => (
                <p key={index}>
                  {review.decision === "accept" ? "Accepted" : "Rejected"} by {actor(review.actor)}{" "}
                  · {time(review.at)}. {review.reason}
                </p>
              ))
            : "No recorded decision"}
        </dd>
        <dt>Dreaming run</dt>
        <dd>
          {run ? (
            <>
              <p>
                {time(run.startedAt)}
                {run.completedAt ? ` to ${time(run.completedAt)}` : " · not finished"} · “
                {run.userRequest}”
              </p>
              <p>
                {run.disposition === "automatic"
                  ? `Routine work${run.permission ? ` (${run.permission})` : ""} decided by the agent`
                  : "Presented for a human decision"}
              </p>
            </>
          ) : (
            "No dreaming run on this desktop"
          )}
        </dd>
      </dl>
      <h3>Why</h3>
      <p>{change.reason}</p>
      {run && (
        <>
          <h3>Evidence given by the agent</h3>
          <p>{run.evidence}</p>
        </>
      )}
      {change.status === "pending" && (
        <p className="librarian-note">
          Pending proposal. Accepted memory is unchanged.
          {run?.decidable ? "" : " Decisions happen in an open dreaming run."}
        </p>
      )}
      {run?.decidable && (
        <Button disabled={busy} onClick={() => navigate({ view: "decision", changeId: change.id })}>
          Open in Dreaming
        </Button>
      )}
      <div className="librarian-comparison">
        <section>
          <h3>Before</h3>
          {before === null ? <p>No memory</p> : <Markdown text={before} />}
        </section>
        <section>
          <h3>After{change.status === "rejected" ? " (rejected)" : ""}</h3>
          {after === null ? <p>Memory removed</p> : <Markdown text={after} />}
        </section>
      </div>
      <h3>Cited source revisions · {change.sources.length}</h3>
      {change.sources.length ? (
        <ul className="memory-link-list" aria-label="Cited source revisions">
          {change.sources.map((source) => (
            <li key={`${source.path}-${source.hash}`}>
              <button
                onClick={() =>
                  navigate({ view: "activity", activity: { ...options, sourceHash: source.hash } })
                }
              >
                {source.displayTitle || source.path}
              </button>
              <small>
                {source.path} · revision {source.hash.slice(0, 12)}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>This change cites no source revisions.</p>
      )}
    </section>
  );
}

export function ActivityView({
  state,
  busy,
  navigate,
}: {
  state: LibrarianView;
  busy: boolean;
  navigate: (selection: Navigation) => void;
}) {
  const activity = state.displayed as MemoryActivity | null;
  const options: LibrarianActivity = state.activity ?? { offset: 0, onlySelected: false };
  if (!activity) return <p role="status">Reading recorded changes…</p>;
  const update = (next: Partial<LibrarianActivity>) =>
    navigate({
      view: "activity",
      activity: { ...options, offset: 0, changeId: undefined, sourceHash: undefined, ...next },
    });
  const runs = [...state.history, ...(state.run ? [state.run] : [])].slice(-10).reverse();
  const detail = !!activity.selected;
  const selectedOnly = options.onlySelected && !!state.focusPath;
  return (
    <section
      className={detail ? "librarian-activity reading" : "librarian-activity"}
      aria-label="Activity"
    >
      <div className="librarian-toolbar">
        <label className="librarian-filter">
          <span>Outcome</span>
          <NativeSelect
            aria-label="Outcome"
            size="sm"
            value={options.status ?? ""}
            disabled={busy}
            onChange={(event) =>
              update({
                status: (event.target.value || undefined) as LibrarianActivity["status"],
              })
            }
          >
            <NativeSelectOption value="">All</NativeSelectOption>
            {(["pending", "accepted", "rejected", "superseded"] as const).map((value) => (
              <NativeSelectOption key={value} value={value}>
                {outcome(value)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <Button
          variant={selectedOnly ? "secondary" : "outline"}
          size="sm"
          aria-pressed={options.onlySelected && !!state.focusPath}
          disabled={busy || !state.focusPath}
          onClick={() => update({ onlySelected: !options.onlySelected })}
        >
          Selected memory only
        </Button>
        {state.focusPath && <small className="librarian-note">{state.focusPath}</small>}
      </div>
      <p className="librarian-note">
        Recorded changes in this desktop's copy of the library, including changes synced from other
        machines. Changes not yet synced, or waiting in a conflict pull request, are not shown.
        Records do not say which machine made a change. Edits made outside recorded changes have no
        attribution.
      </p>
      <div className="librarian-split">
        <section className="librarian-results" aria-label="Recorded work">
          {activity.missingChange && <p role="status">That change is not in this library.</p>}
          <p className="librarian-note">
            {!activity.page.length
              ? "No recorded changes match."
              : selectedOnly
                ? `${activity.offset + 1}–${activity.offset + activity.page.length} recorded changes to this memory, newest first`
                : `${activity.offset + 1}–${activity.offset + activity.page.length} of ${activity.total} recorded changes, newest first`}
          </p>
          {selectedOnly && (
            <p className="librarian-note">
              {activity.partial ? `Searched the latest ${activity.scanned} recorded changes. ` : ""}
              Changes made under an earlier file name are not shown.
            </p>
          )}
          <ul className="memory-link-list" aria-label="Recorded changes">
            {activity.page.map((change) => (
              <li key={change.id}>
                <ChangeItem
                  change={change}
                  current={change.id === options.changeId}
                  onOpen={() =>
                    navigate({
                      view: "activity",
                      activity: { ...options, changeId: change.id, sourceHash: undefined },
                    })
                  }
                />
              </li>
            ))}
          </ul>
          <div className="memory-note-actions">
            {activity.offset > 0 && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => update({ offset: Math.max(0, activity.offset - 20) })}
              >
                Newer
              </Button>
            )}
            {activity.more && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => update({ offset: activity.offset + 20 })}
              >
                Older
              </Button>
            )}
          </div>
          {!!runs.length && (
            <>
              <h3>Dreaming runs · latest {runs.length}</h3>
              <ul className="memory-link-list" aria-label="Dreaming runs">
                {runs.map((run) => (
                  <li key={run.id}>
                    {run.status === "completed" ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          navigate(
                            run.id === state.run?.id
                              ? { view: "overview" }
                              : { view: "overview", historyRunId: run.id },
                          )
                        }
                      >
                        {time(run.startedAt)}
                      </button>
                    ) : (
                      <span>{time(run.startedAt)}</span>
                    )}
                    <small>
                      {run.status === "completed"
                        ? `Finished ${run.completedAt ? time(run.completedAt) : ""}`
                        : run.status === "active"
                          ? "In progress"
                          : "Paused"}{" "}
                      · “{run.userRequest}”
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        {activity.revision ? (
          <Evidence
            revision={activity.revision}
            onBack={() =>
              navigate({ view: "activity", activity: { ...options, sourceHash: undefined } })
            }
            onCurrent={() =>
              navigate({
                view: "memory",
                path: activity.revision!.path,
                ...(options.changeId ? { returnChangeId: options.changeId } : {}),
              })
            }
          />
        ) : activity.selected ? (
          <Detail activity={activity} options={options} busy={busy} navigate={navigate} />
        ) : (
          <section className="librarian-detail librarian-wide-only">
            <p className="librarian-note">Choose a recorded change to inspect it here.</p>
          </section>
        )}
      </div>
    </section>
  );
}
