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
  name,
  target,
  onTargetChange,
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
  name?: string;
  target: "external" | "embedded";
  onTargetChange: (target: "external" | "embedded") => void;
}) {
  const preferences = useContext(SettingsContext);
  const external = Boolean(name) && target === "external";
  const enabled = external || (preferences?.settings?.diagramGenerationEnabled ?? false);
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
          <h2>{external ? "Your coding agent" : "Diagram agent"}</h2>
          <p className="secondary">{external ? name : "Gemini 3.8 Flash · OpenRouter"}</p>
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
      {name && (
        <div className="chat-target">
          <label>
            Send to{" "}
            <select
              aria-label="Conversation recipient"
              value={target}
              onChange={(event) => onTargetChange(event.target.value as "external" | "embedded")}
            >
              <option value="external">Your coding agent</option>
              <option value="embedded">Scope diagram agent</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(name)}
          >
            Copy name
          </Button>
        </div>
      )}
      <div
        className="chat-history"
        role="log"
        aria-label="Diagram conversation"
        aria-live="polite"
        ref={history}
      >
        {!messages.length && (
          <p className="secondary">
            {external
              ? "Keep your coding agent's Scope listener running to receive messages and canvas edits. Use this name to reconnect in another session."
              : "Describe a change to this diagram. You can edit the result on the canvas. Changes save automatically."}
          </p>
        )}
        {messages.map((message, index) => (
          <div className={`chat-message${message.role === "user" ? " from-user" : ""}`} key={index}>
            <strong>
              {message.role === "user"
                ? "You"
                : message.agent === "external"
                  ? "Your coding agent"
                  : "Diagram agent"}
            </strong>
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
            maxLength={external ? 4000 : 16000}
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
