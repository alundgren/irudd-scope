import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Check, CircleAlert, LoaderCircle, Square, Wrench, X } from "lucide-react";
import { Button } from "../../../renderer/components/ui/button.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "../../../renderer/components/ui/native-select.tsx";
import { Textarea } from "../../../renderer/components/ui/textarea.tsx";
import {
  MAX_MESSAGE,
  type ChatHarnessId,
  type ChatItem,
  type ChatState,
  type ScopeChatBridge,
} from "./contract.ts";

declare global {
  interface Window {
    scopeChat: ScopeChatBridge;
  }
}

const TURN_LABELS = {
  done: "Turn finished",
  stopped: "Stopped",
  interrupted: "Interrupted when Scope quit",
  failed: "Turn failed",
} as const;

type Run = (action: Promise<unknown>) => void;

/** One card's chat: its messages, tool activity, approvals, and turn results. */
export function ChatPanel() {
  const [state, setState] = useState<ChatState>();
  const [harness, setHarness] = useState<ChatHarnessId | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const stop = window.scopeChat.onState(setState);
    void window.scopeChat.state().then(setState, () => {});
    return stop;
  }, []);
  const targetKey = state?.target ? `${state.target.tabId}/${state.target.cardId}` : "";
  useEffect(() => setError(undefined), [targetKey]);

  const run: Run = (action) => {
    setError(undefined);
    action.catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message.replace(/^.*Error: /, "") : String(reason)),
    );
  };
  if (!state) return <div className="chat-panel" aria-busy="true" />;
  const chosen = harness ?? state.harness;
  const alert = state.blocked ?? error;
  return (
    <div className="chat-panel">
      <ChatHeader state={state} chosen={chosen} onChoose={setHarness} />
      <ChatItems key={targetKey} state={state} run={run} />
      {alert && (
        <p className="chat-alert" role="alert">
          <CircleAlert aria-hidden /> {alert}
        </p>
      )}
      <ChatComposer key={targetKey} state={state} chosen={chosen} run={run} />
    </div>
  );
}

function ChatHeader({
  state,
  chosen,
  onChoose,
}: {
  state: ChatState;
  chosen: ChatHarnessId | null;
  onChoose: (harness: ChatHarnessId) => void;
}) {
  return (
    <header className="chat-header">
      <h2>Chat</h2>
      {state.harnesses.length > 1 ? (
        <NativeSelect
          size="sm"
          aria-label="Chat program"
          value={chosen ?? ""}
          disabled={state.running}
          onChange={(event) => onChoose(event.target.value as ChatHarnessId)}
        >
          {state.harnesses.map((item) => (
            <NativeSelectOption key={item.id} value={item.id}>
              {item.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        state.harnesses[0] && <span className="chat-account">{state.harnesses[0].label}</span>
      )}
      {state.account && <span className="chat-account">{state.account}</span>}
    </header>
  );
}

/** The conversation, kept scrolled to the newest item unless the person scrolled up. */
function ChatItems({ state, run }: { state: ChatState; run: Run }) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [state]);
  return (
    <ol
      ref={list}
      className="chat-items"
      aria-label="Chat messages"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      {state.items.length === 0 && (
        <li className="chat-empty">
          {state.harnesses.length
            ? "Ask about this card, or ask for changes to it."
            : "Scope can't find Claude Code or Codex on this computer."}
        </li>
      )}
      {state.items.map((item) => (
        <ChatEntry key={item.id} item={item} run={run} />
      ))}
    </ol>
  );
}

function ChatComposer({
  state,
  chosen,
  run,
}: {
  state: ChatState;
  chosen: ChatHarnessId | null;
  run: Run;
}) {
  const [draft, setDraft] = useState("");
  const ready = Boolean(state.target && chosen && !state.blocked);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !chosen || state.running) return;
    setDraft("");
    run(window.scopeChat.send({ text, harness: chosen }));
  };
  return (
    <form className="chat-composer" onSubmit={submit}>
      <Textarea
        aria-label="Message"
        placeholder={ready ? "Message" : undefined}
        value={draft}
        disabled={!ready}
        maxLength={MAX_MESSAGE}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)
            submit(event);
        }}
      />
      {state.running ? (
        <Button type="button" variant="secondary" onClick={() => run(window.scopeChat.stop())}>
          <Square /> Stop
        </Button>
      ) : (
        <Button type="submit" disabled={!ready || !draft.trim()}>
          Send
        </Button>
      )}
    </form>
  );
}

function ChatEntry({ item, run }: { item: ChatItem; run: Run }) {
  switch (item.kind) {
    case "message":
      return <li className={`chat-message chat-message-${item.role}`}>{item.text}</li>;
    case "tool":
      return (
        <li className="chat-tool" data-state={item.state}>
          {item.state === "running" ? (
            <LoaderCircle className="chat-spin" aria-label="Running" />
          ) : item.state === "done" ? (
            <Wrench aria-label="Done" />
          ) : (
            <X aria-label="Failed" />
          )}
          <span className="chat-tool-name">{item.name}</span>
          {item.detail && <span className="chat-tool-detail">{item.detail}</span>}
        </li>
      );
    case "approval":
      return <ApprovalCard item={item} run={run} />;
    case "turn":
      return <TurnCard item={item} run={run} />;
    case "notice":
      return <li className="chat-notice">{item.text}</li>;
  }
}

function ApprovalCard({ item, run }: { item: Extract<ChatItem, { kind: "approval" }>; run: Run }) {
  const answer = (allow: boolean) => run(window.scopeChat.approve({ id: item.id, allow }));
  return (
    <li className="chat-card" aria-label={item.title}>
      <strong>{item.title}</strong>
      <pre className="chat-detail">{item.detail}</pre>
      {item.state === "pending" ? (
        <div className="chat-actions">
          <Button size="sm" onClick={() => answer(true)}>
            Allow
          </Button>
          <Button size="sm" variant="secondary" onClick={() => answer(false)}>
            Deny
          </Button>
        </div>
      ) : (
        <span className="chat-muted">{item.state === "allowed" ? "Allowed" : "Denied"}</span>
      )}
    </li>
  );
}

function TurnCard({ item, run }: { item: Extract<ChatItem, { kind: "turn" }>; run: Run }) {
  const label = TURN_LABELS[item.state];
  return (
    <li className="chat-card chat-turn" data-state={item.state} aria-label={label}>
      <span className="chat-turn-title">
        {item.state === "done" ? <Check aria-hidden /> : <CircleAlert aria-hidden />}
        {label}
      </span>
      {item.error && <span className="chat-muted">{item.error}</span>}
      {item.changes.length > 0 && (
        <ul className="chat-changes">
          {item.changes.map((change, index) => (
            <li key={index}>{change}</li>
          ))}
        </ul>
      )}
      {item.changes.length > 0 &&
        (item.undone ? (
          <span className="chat-muted">Undone</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => run(window.scopeChat.undoTurn({ turnId: item.id }))}
          >
            Undo turn
          </Button>
        ))}
    </li>
  );
}
