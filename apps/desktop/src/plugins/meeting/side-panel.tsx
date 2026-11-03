import { useEffect, useRef, useState } from "react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import type { Section } from "./contract.ts";
import type { Activity, LoopSnapshot } from "./loop.ts";

const FLASH_MS = 2_000;

function stickToBottom(list: HTMLElement | null, count: number) {
  // Keep the newest row visible unless the person scrolled up to read.
  if (!list) return;
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (near || count <= 1) list.scrollTop = list.scrollHeight;
}

function ActivityRow({ entry }: { entry: Activity }) {
  const title =
    entry.kind === "notice"
      ? "Notice"
      : entry.kind === "edit"
        ? "Canvas edit"
        : entry.kind === "voice"
          ? "Voice command"
          : "Transcription";
  const facts = [
    entry.backend === "codex" ? "Codex" : entry.backend === "openrouter" ? "OpenRouter" : "",
    entry.model ?? "",
    entry.ms === undefined ? "" : `${entry.ms} ms`,
    entry.applied === undefined ? "" : `${entry.applied} applied`,
    entry.rejected?.length ? `${entry.rejected.length} rejected` : "",
  ].filter(Boolean);
  return (
    <li className={entry.error ? "mc-activity-row is-error" : "mc-activity-row"}>
      <div>
        <strong>{title}</strong>
        {facts.length > 0 && <span className="mc-muted"> · {facts.join(" · ")}</span>}
      </div>
      {entry.detail && <div className="mc-activity-detail">{entry.detail}</div>}
      {entry.error && <div className="mc-activity-error">{entry.error}</div>}
      {entry.rejected && entry.rejected.length > 0 && (
        <ul className="mc-activity-rejected">
          {entry.rejected.map((rejection, index) => (
            <li key={index}>
              {rejection.op.op}
              {rejection.op.section ? ` in ${rejection.op.section}` : ""}
              {rejection.op.id ? ` ${rejection.op.id}` : ""}: {rejection.reason}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SectionList({
  sections,
  flashed,
  blockCount,
  onSelect,
}: {
  sections: readonly Section[];
  flashed?: { id: string; at: number };
  blockCount: number;
  onSelect: (id: string) => void;
}) {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!flashed) return;
    const timer = setTimeout(() => setClock((n) => n + 1), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashed]);
  const lit = flashed && Date.now() - flashed.at < FLASH_MS ? flashed.id : undefined;
  return (
    <section className="mc-side-section mc-side-sections">
      <h2>
        Sections
        {sections.length > 0 && (
          <span className="mc-muted">
            {" "}
            · {sections.length} sections, {blockCount} blocks
          </span>
        )}
      </h2>
      {sections.length ? (
        <ul className="mc-sections">
          {sections.map((section) => (
            <li key={section.id}>
              <Button
                variant="ghost"
                size="sm"
                className={section.id === lit ? "mc-section-link is-fresh" : "mc-section-link"}
                title={`Zoom to ${section.name}`}
                onClick={() => onSelect(section.id)}
              >
                {section.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mc-muted">Each request adds or changes a named section.</p>
      )}
    </section>
  );
}

export function SidePanel({
  loop,
  sections,
  flashed,
  blockCount,
  onAsk,
  onSelectSection,
}: {
  loop: LoopSnapshot;
  sections: readonly Section[];
  flashed?: { id: string; at: number };
  blockCount: number;
  onAsk: (request: string) => void;
  onSelectSection: (id: string) => void;
}) {
  const [request, setRequest] = useState("");
  const transcript = useRef<HTMLOListElement>(null);
  const activity = useRef<HTMLOListElement>(null);
  useEffect(() => stickToBottom(transcript.current, loop.lines.length), [loop.lines]);
  useEffect(() => stickToBottom(activity.current, loop.activity.length), [loop.activity]);
  return (
    <aside className="mc-side" aria-label="Meeting activity">
      <section className="mc-side-section mc-side-transcript">
        <h2>Transcript</h2>
        {loop.lines.length ? (
          <ol ref={transcript} className="mc-transcript" aria-live="polite">
            {loop.lines.map((line) => (
              <li
                key={line.id}
                className={line.wake ? "is-wake" : undefined}
                title={line.wake ? "Heard as a canvas request" : undefined}
              >
                {line.text}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mc-muted">
            Turn on Listen to transcribe the room. Only requests that start with “Canvas” go to the
            model.
          </p>
        )}
      </section>
      <form
        className="mc-ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (!request.trim()) return;
          onAsk(request);
          setRequest("");
        }}
      >
        <Input
          aria-label="Ask the canvas"
          placeholder="Ask the canvas, such as “draw the login flow”"
          maxLength={4000}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!request.trim()}>
          Ask
        </Button>
      </form>
      <SectionList
        sections={sections}
        flashed={flashed}
        blockCount={blockCount}
        onSelect={onSelectSection}
      />
      <section className="mc-side-section mc-side-activity">
        <h2>Activity{loop.editing && <span className="mc-muted"> · Updating the canvas…</span>}</h2>
        {loop.activity.length ? (
          <ol ref={activity} className="mc-activity">
            {loop.activity.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ol>
        ) : (
          <p className="mc-muted">
            Each transcription, canvas edit and voice command appears here.
          </p>
        )}
      </section>
    </aside>
  );
}
