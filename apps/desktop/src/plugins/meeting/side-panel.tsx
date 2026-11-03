import { useEffect, useRef, useState } from "react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Input } from "../../renderer/components/ui/input.tsx";
import type { Activity, LoopSnapshot } from "./loop.ts";

function stickToBottom(list: HTMLElement | null, count: number) {
  // Keep the newest row visible unless the person scrolled up to read.
  if (!list) return;
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (near || count <= 1) list.scrollTop = list.scrollHeight;
}

function ActivityRow({ entry }: { entry: Activity }) {
  const title =
    entry.kind === "notice" ? "Notice" : entry.kind === "edit" ? "Page edit" : "Transcription";
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
              {rejection.op.id ? ` ${rejection.op.id}` : ""}: {rejection.reason}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function SidePanel({
  loop,
  onAsk,
}: {
  loop: LoopSnapshot;
  onAsk: (request: string) => void;
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
                className={line.sent ? undefined : "is-fresh"}
                title={line.sent ? undefined : "Not yet sent to the model"}
              >
                {line.text}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mc-muted">Turn on Listen to transcribe the room.</p>
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
      <section className="mc-side-section mc-side-activity">
        <h2>Activity{loop.editing && <span className="mc-muted"> · Updating the page…</span>}</h2>
        {loop.activity.length ? (
          <ol ref={activity} className="mc-activity">
            {loop.activity.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </ol>
        ) : (
          <p className="mc-muted">Each transcription and page edit appears here.</p>
        )}
      </section>
    </aside>
  );
}
