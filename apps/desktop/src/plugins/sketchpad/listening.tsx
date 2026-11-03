import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Switch } from "../../renderer/components/ui/switch.tsx";
import { applyListeningEdits, canvasItems, canvasVersion } from "./listening-canvas.ts";
import { captureRoom } from "./microphone.ts";

type Session = {
  controller: AbortController;
  id?: string;
  queue: string[];
  summary: string;
  busy: boolean;
};

export function SketchpadListening({
  api,
  enabled,
}: {
  api: ExcalidrawImperativeAPI | undefined;
  enabled: boolean;
}) {
  const session = useRef<Session | undefined>(undefined);
  const [phase, setPhase] = useState("off");
  const [error, setError] = useState("");
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState("");
  function stop(message = "") {
    const current = session.current;
    session.current = undefined;
    current?.controller.abort();
    if (current?.id) void window.scope.stopSketchpadListening(current.id).catch(() => {});
    setPhase("off");
    setError(message);
  }
  useEffect(() => () => stop(), []);
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled]);

  async function drain(current: Session) {
    if (current.busy || !current.id || !api) return;
    current.busy = true;
    try {
      while (session.current === current && current.queue.length) {
        const audio = current.queue.shift()!;
        const items = canvasItems(api);
        const version = canvasVersion(api);
        setPhase("updating");
        const reply = await window.scope.processSketchpadAudio({
          sessionId: current.id,
          audio,
          summary: current.summary,
          items,
        });
        if (session.current !== current) return;
        current.summary = reply.summary;
        setHeard(reply.transcript);
        if (version === canvasVersion(api)) {
          applyListeningEdits(api, reply);
          setNotice(
            reply.edits.length
              ? `Applied ${reply.edits.length} canvas edits. Undo with Ctrl+Z or Command+Z.`
              : "No canvas changes.",
          );
        } else
          setNotice("Canvas changed while processing. Skipped this update to keep your edits.");
      }
      if (session.current === current) setPhase("listening");
    } catch (cause) {
      if (session.current === current)
        stop(
          cause instanceof Error
            ? cause.message
            : "Could not update the canvas. Toggle listening to retry.",
        );
    } finally {
      current.busy = false;
    }
  }

  async function start() {
    if (!api || !enabled || session.current) return;
    const current: Session = {
      controller: new AbortController(),
      queue: [],
      summary: "",
      busy: false,
    };
    session.current = current;
    setPhase("starting");
    setError("");
    setHeard("");
    setNotice("");
    try {
      canvasItems(api);
      current.id = await window.scope.startSketchpadListening();
      if (session.current !== current) {
        await window.scope.stopSketchpadListening(current.id);
        return;
      }
      await captureRoom(
        current.controller.signal,
        (audio) => {
          if (session.current !== current) return;
          if (current.queue.length >= 3) {
            stop("Audio processing fell behind. Listening stopped; toggle it to retry.");
            return;
          }
          current.queue.push(audio);
          void drain(current);
        },
        (message) => stop(message),
      );
      if (session.current === current) setPhase("listening");
    } catch (cause) {
      if (session.current === current)
        stop(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "Microphone access was denied. Allow Scope in system privacy settings, then toggle listening."
            : cause instanceof Error
              ? cause.message
              : "Could not start the microphone. Toggle listening to retry.",
        );
    }
  }
  return (
    <div className="sketchpad-listening">
      <div className="sketchpad-listening-controls">
        <Switch
          label="Listening"
          checked={phase !== "off"}
          disabled={!enabled}
          onCheckedChange={(checked) => (checked ? void start() : stop())}
        />
        <span role="status" aria-live="polite">
          {phase === "starting"
            ? "Opening microphone…"
            : phase === "updating"
              ? "Updating canvas…"
              : phase === "listening"
                ? "Listening to the room…"
                : "Microphone off"}
        </span>
        <span className="sketchpad-listening-provider">
          Gemini 2.5 Flash Lite · Audio sent to OpenRouter
        </span>
      </div>
      {error && <div role="alert">{error}</div>}
      {heard && (
        <div className="sketchpad-listening-heard" title={heard}>
          Heard: {heard}
        </div>
      )}
      {notice && <div className="sketchpad-listening-notice">{notice}</div>}
    </div>
  );
}
