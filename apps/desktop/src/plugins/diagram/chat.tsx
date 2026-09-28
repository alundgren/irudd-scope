import { useContext, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "../../renderer/components/ui/button.tsx";
import { Textarea } from "../../renderer/components/ui/textarea.tsx";
import type { DiagramDraft } from "./draft.ts";
import { SettingsContext } from "../../renderer/settings-context.tsx";

export function DiagramChat({
  open,
  focus,
  messages,
  intent,
  busy,
  ready,
  onClose,
  onIntentChange,
  onSend,
  onCancel,
}: {
  open: boolean;
  focus: boolean;
  messages: DiagramDraft["messages"];
  intent: string;
  busy: "generation" | "saving" | null;
  ready: boolean;
  onClose: () => void;
  onIntentChange: (intent: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const preferences = useContext(SettingsContext);
  const enabled = preferences?.settings?.diagramGenerationEnabled ?? false;
  const history = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
  }, [messages, open, focus]);
  useEffect(() => {
    if (open && !focus && enabled) composer.current?.focus({ preventScroll: true });
  }, [open, focus, enabled]);
  return (
    <aside className="diagram-chat" aria-label="Diagram agent" hidden={!open || focus}>
      <div className="chat-heading">
        <div>
          <h2>Diagram agent</h2>
          <p className="secondary">Gemini 3.8 Flash · OpenRouter</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close diagram chat"
          title="Close diagram chat"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div
        className="chat-history"
        role="log"
        aria-label="Diagram conversation"
        aria-live="polite"
        ref={history}
      >
        {!messages.length && (
          <p className="secondary">
            Describe a change to this diagram. You can edit the result on the canvas. Changes save
            automatically.
          </p>
        )}
        {messages.map((message, index) => (
          <div className={`chat-message${message.role === "user" ? " from-user" : ""}`} key={index}>
            <strong>{message.role === "user" ? "You" : "Diagram agent"}</strong>
            <p>{message.text}</p>
            {message.details && <p className="secondary">{message.details}</p>}
          </div>
        ))}
        {busy === "generation" && (
          <p role="status" className="secondary">
            Updating diagram…
          </p>
        )}
      </div>
      {!enabled ? (
        <div className="chat-form">
          <p>Enable diagram generation in Settings to ask the diagram agent.</p>
          <Button onClick={() => preferences?.openSettings("diagram generation")}>
            Open diagram settings
          </Button>
        </div>
      ) : (
        <form
          className="chat-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <Textarea
            ref={composer}
            aria-label="Change diagram"
            placeholder="Describe a change…"
            value={intent}
            maxLength={16000}
            disabled={busy === "generation"}
            onChange={(event) => onIntentChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <div className="chat-actions">
            <span className="secondary">Shift + Enter for a new line</span>
            {busy === "generation" ? (
              <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={busy !== null || !ready || !intent.trim()}>
                Send
              </Button>
            )}
          </div>
        </form>
      )}
    </aside>
  );
}
